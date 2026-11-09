//! The WAL's keeper: a thread with a connection of its own that copies the log back into the database, and makes the log start over when writes never let it.
//!
//! A passive checkpoint copies the log without waiting for anyone, but it cannot make the log start over: that happens only when a write transaction begins with
//! nothing left to copy, and a writer that commits again and again always has a commit between the end of a checkpoint and its next transaction (the log grew to
//! gigabytes under saturated inserts). Past the hard limit the thread therefore raises `paused`, which the writer checks before each batch, and takes the write
//! lock with a RESTART checkpoint. Reads are never held; writes wait for one checkpoint (it copies only the newest version of each hot page).
//!
//! Several processes may use the file (a cluster of servers on one database): then the pause is also a lock on a file beside the database, which the thread holds
//! exclusively for the checkpoint and every writer, in any process, tests before its next batch. One process runs the thread; the others only test.

use rusqlite::{Connection as Sqlite, OpenFlags};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

const SOFT: u64 = 32 * 1024 * 1024;
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

    /// Whether writers should hold their next batch (a RESTART checkpoint is waiting for the write lock or running, in this process or another).
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
    let mut last_log: i64 = -1;
    while !stop.load(Ordering::Acquire) {
        // looks every 50 ms (saturated inserts put hundreds of megabytes a second in the log), in short steps so a close does not wait
        for _ in 0..5 {
            if stop.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let size = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
        if size <= SOFT {
            continue;
        }
        if conn.is_none() {
            conn = Sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok();
        }
        let Some(c) = conn.as_ref() else { continue };
        let Ok(log) = checkpoint(c, "PASSIVE") else { continue };
        // over the hard limit and written to since the last look (an idle database waits for its next write to start the log over)
        if size > HARD && log != last_log {
            paused.store(true, Ordering::Release);
            // the other processes' writers see the pause as this lock; writers hold theirs for an instant, so it is had within a few tries
            let locked = lock.as_ref().map(|f| (0..200).any(|_| flock(f, libc::LOCK_EX | libc::LOCK_NB) || { std::thread::sleep(Duration::from_millis(1)); false }));
            if locked != Some(false) {
                let _ = c.busy_timeout(Duration::from_secs(5));
                let _ = checkpoint(c, "RESTART");
                let _ = c.busy_timeout(Duration::ZERO);
            }
            if let (Some(f), Some(true)) = (&lock, locked) {
                flock(f, libc::LOCK_UN);
            }
            paused.store(false, Ordering::Release);
        }
        last_log = log;
    }
}

/// Runs `PRAGMA wal_checkpoint(mode)`; the number of frames in the log.
fn checkpoint(c: &Sqlite, mode: &str) -> rusqlite::Result<i64> {
    c.query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |r| r.get::<_, i64>(1))
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
}
