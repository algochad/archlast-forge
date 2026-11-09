//! The WAL's keeper: a thread with a connection of its own that copies the log back into the database, and makes the log start over when writes never let it.
//!
//! A passive checkpoint copies the log without waiting for anyone, but it cannot make the log start over: that happens only when a write transaction begins with
//! nothing left to copy, and a writer that commits again and again always has a commit between the end of a checkpoint and its next transaction (the log grew to
//! gigabytes under saturated inserts). Past the hard limit the thread therefore raises `paused`, which the writer checks before each batch, and takes the write
//! lock with a RESTART checkpoint. Reads are never held; writes wait for one checkpoint (it copies only the newest version of each hot page).

use rusqlite::{Connection as Sqlite, OpenFlags};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

const SOFT: u64 = 32 * 1024 * 1024;
const HARD: u64 = 64 * 1024 * 1024;

pub struct Checkpointer {
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Checkpointer {
    /// Starts the thread for the database file at `path` (which must be in WAL mode, or become so before the log grows).
    pub fn start(path: String) -> Self {
        let paused = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (p, s) = (paused.clone(), stop.clone());
        let handle = std::thread::Builder::new().name("archlast-db-checkpoint".into()).spawn(move || run(&path, &p, &s)).ok();
        Self { paused, stop, handle }
    }

    /// Whether writers should hold their next batch (a RESTART checkpoint is waiting for the write lock or running).
    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
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

fn run(path: &str, paused: &AtomicBool, stop: &AtomicBool) {
    let wal = format!("{path}-wal");
    let mut conn: Option<Sqlite> = None;
    let mut last_log: i64 = -1;
    while !stop.load(Ordering::Acquire) {
        // sleeps in short steps so a close does not wait a quarter of a second
        for _ in 0..25 {
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
            let _ = c.busy_timeout(Duration::from_secs(5));
            let _ = checkpoint(c, "RESTART");
            let _ = c.busy_timeout(Duration::ZERO);
            paused.store(false, Ordering::Release);
        }
        last_log = log;
    }
}

/// Runs `PRAGMA wal_checkpoint(mode)`; the number of frames in the log.
fn checkpoint(c: &Sqlite, mode: &str) -> rusqlite::Result<i64> {
    c.query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |r| r.get::<_, i64>(1))
}
