//! The WAL's keeper: a thread with a connection of its own that checkpoints the log when it grows.
//!
//! A passive checkpoint can take a long time to copy a large log while writers continue to append to it. Instead, once the log passes the limit, the keeper
//! pauses writers before checkpointing and uses TRUNCATE to copy and reset it. SQLite waits for existing readers; it never invalidates their snapshots.
//!
//! Several processes may use the file (a cluster of servers on one database): the pause is also a lock on a file beside the database, which the keeper holds
//! exclusively for the checkpoint and every writer, in any process, tests before its next batch. One process runs the thread; the others only test.

use rusqlite::{Connection as Sqlite, OpenFlags};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

// A checkpoint may exceed this by writes already in flight and writes made before the keeper is scheduled. A long-lived reader can delay it further.
const HARD: u64 = 64 * 1024 * 1024;

pub struct Checkpointer {
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    /// The pause lock, when other processes use the file too.
    shared: Option<Shared>,
}

/// The test of the pause lock: at most one system call pair a millisecond, however often a writer asks.
struct Shared {
    file: File,
    epoch: std::time::Instant,
    checked: AtomicU64,
    held: AtomicBool,
}

fn pause_file(path: &str) -> Option<File> {
    OpenOptions::new().create(true).truncate(false).write(true).open(format!("{path}-pause")).ok()
}

fn flock(file: &File, op: libc::c_int) -> bool {
    // SAFETY: the descriptor belongs to `file`, which outlives the call
    unsafe { libc::flock(file.as_raw_fd(), op) == 0 }
}

impl Checkpointer {
    /// Starts the thread for the database file at `path` (which must be in WAL mode, or become so before the log grows). `thread` false: this process only tests the pause
    /// (another process keeps the log); `shared`: other processes use the file, so the pause is a lock they all see.
    pub fn start(path: String, thread: bool, shared: bool) -> Self {
        let paused = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (p, s) = (paused.clone(), stop.clone());
        let lock = if shared { pause_file(&path) } else { None };
        // (opened again, not duplicated: a lock belongs to an open file description, and the thread's must not be the one `paused` tests and lets go of)
        let held_by_thread = if shared && thread { pause_file(&path) } else { None };
        let handle = if thread { std::thread::Builder::new().name("archlast-db-checkpoint".into()).spawn(move || run(&path, &p, &s, held_by_thread)).ok() } else { None };
        let shared = lock.map(|file| Shared { file, epoch: std::time::Instant::now(), checked: AtomicU64::new(u64::MAX), held: AtomicBool::new(false) });
        Self { paused, stop, handle, shared }
    }

    /// Whether writers should hold their next batch (a checkpoint is waiting for the write lock or running, in this process or another).
    pub fn paused(&self) -> bool {
        if self.paused.load(Ordering::Acquire) {
            return true;
        }
        let Some(s) = &self.shared else { return false };
        let now = s.epoch.elapsed().as_millis() as u64;
        if s.checked.swap(now, Ordering::AcqRel) == now {
            return s.held.load(Ordering::Acquire);
        }
        // a shared lock is given unless the thread holds the exclusive one
        let free = flock(&s.file, libc::LOCK_SH | libc::LOCK_NB);
        if free {
            flock(&s.file, libc::LOCK_UN);
        }
        s.held.store(!free, Ordering::Release);
        !free
    }

    /// Stops the thread and waits for it.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Checkpointer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(path: &str, paused: &AtomicBool, stop: &AtomicBool, lock: Option<File>) {
    let wal = format!("{path}-wal");
    let mut conn: Option<Sqlite> = None;
    let mut retry_after = std::time::Instant::now();
    while !stop.load(Ordering::Acquire) {
        // Poll in short steps so a close does not wait for the full interval.
        for _ in 0..5 {
            if stop.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let size = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
        if size <= HARD || std::time::Instant::now() < retry_after {
            continue;
        }
        if conn.is_none() {
            conn = Sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok();
        }
        let Some(c) = conn.as_ref() else { continue };
        if !truncate(c, paused, lock.as_ref(), Duration::from_secs(5)) {
            // A reader can hold an old snapshot indefinitely. Let writers make progress before trying again.
            retry_after = std::time::Instant::now() + Duration::from_secs(1);
        }
    }
}

/// Pause writers before copying the log, including writers in other processes. A busy checkpoint must be retried: SQLite reports it in the first result column.
fn truncate(c: &Sqlite, paused: &AtomicBool, lock: Option<&File>, timeout: Duration) -> bool {
    paused.store(true, Ordering::Release);
    let locked = lock.map(|f| (0..200).any(|_| flock(f, libc::LOCK_EX | libc::LOCK_NB) || { std::thread::sleep(Duration::from_millis(1)); false }));
    let completed = if locked == Some(false) {
        false
    } else {
        let _ = c.busy_timeout(timeout);
        let result = c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0));
        let _ = c.busy_timeout(Duration::ZERO);
        matches!(result, Ok(0))
    };
    if let (Some(f), Some(true)) = (lock, locked) {
        flock(f, libc::LOCK_UN);
    }
    paused.store(false, Ordering::Release);
    completed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pause_is_a_lock_every_process_sees() {
        let dir = std::env::temp_dir().join(format!("afx-pause-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.db").to_str().unwrap().to_string();
        // a process that only tests the pause (the log is kept by another)
        let writer = Checkpointer::start(path.clone(), false, true);
        assert!(!writer.paused());
        // the keeper takes the lock exclusively for its checkpoint
        let keeper = pause_file(&path).unwrap();
        assert!(flock(&keeper, libc::LOCK_EX | libc::LOCK_NB));
        std::thread::sleep(Duration::from_millis(3)); // the test is made at most once a millisecond
        assert!(writer.paused());
        flock(&keeper, libc::LOCK_UN);
        std::thread::sleep(Duration::from_millis(3));
        assert!(!writer.paused());
        // not shared: no lock to see
        let alone = Checkpointer::start(path, false, false);
        assert!(!alone.paused());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn checkpoint_waits_for_a_reader_with_the_shared_pause_held() {
        let dir = std::env::temp_dir().join(format!("afx-checkpoint-reader-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.db").to_str().unwrap().to_string();
        let writer = Sqlite::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1);").unwrap();
        let reader = Sqlite::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        assert_eq!(reader.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        writer.execute_batch("INSERT INTO t VALUES (2)").unwrap();

        let observer = Checkpointer::start(path.clone(), false, true);
        let keeper_path = path.clone();
        let keeper = std::thread::spawn(move || {
            let c = Sqlite::open(&keeper_path).unwrap();
            let lock = pause_file(&keeper_path).unwrap();
            truncate(&c, &AtomicBool::new(false), Some(&lock), Duration::from_secs(5))
        });
        let until = std::time::Instant::now() + Duration::from_secs(2);
        while !observer.paused() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(observer.paused());
        // The reader keeps its original snapshot while the keeper waits for it.
        assert_eq!(reader.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        reader.execute_batch("COMMIT").unwrap();
        assert!(keeper.join().unwrap());
        std::thread::sleep(Duration::from_millis(3));
        assert!(!observer.paused());
        assert_eq!(std::fs::metadata(format!("{path}-wal")).unwrap().len(), 0);
        assert_eq!(writer.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        drop(observer);
        drop(reader);
        drop(writer);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn busy_checkpoint_can_be_retried_without_losing_writes() {
        let dir = std::env::temp_dir().join(format!("afx-checkpoint-busy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.db");
        let writer = Sqlite::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1);").unwrap();
        let reader = Sqlite::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        assert_eq!(reader.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        writer.execute_batch("INSERT INTO t VALUES (2)").unwrap();
        let keeper = Sqlite::open(&path).unwrap();
        let paused = AtomicBool::new(false);
        assert!(!truncate(&keeper, &paused, None, Duration::from_millis(1)));
        assert!(!paused.load(Ordering::Acquire));
        writer.execute_batch("INSERT INTO t VALUES (3)").unwrap();
        assert_eq!(reader.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        reader.execute_batch("COMMIT").unwrap();
        assert!(truncate(&keeper, &paused, None, Duration::from_secs(1)));
        assert_eq!(writer.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        drop(keeper);
        drop(reader);
        drop(writer);
        let _ = std::fs::remove_dir_all(dir);
    }
}
