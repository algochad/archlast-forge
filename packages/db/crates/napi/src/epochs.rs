//! Commit counters in memory shared by every process that uses the database file: one 32-bit counter per table (by a hash of its name), bumped by the process that
//! committed a write to the table and watched by the others, whose read caches then drop what they hold for it. It is what lets the read cache stay on when several
//! servers write the same file (a cluster); without the file, the cache is only for a process that is the only writer.
//!
//! The counter is bumped after the commit, and before the writer is answered: a client that was answered reads what it wrote through any process, and a read that began
//! before is allowed to be served from before.

use std::fs::OpenOptions;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicU32, Ordering};

pub const SLOTS: usize = 4096;

pub struct Epochs {
    base: *const AtomicU32,
    /// The value of each counter as this process last saw it.
    seen: Vec<u32>,
}

fn slot(table: &str) -> usize {
    // FNV-1a: tables that share a slot only cost each other a dropped cache
    let mut h: u32 = 0x811c9dc5;
    for b in table.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h as usize % SLOTS
}

impl Epochs {
    /// Maps the file (made by the first server, zeros): None when it cannot be had, and the cache is then left off by the caller.
    pub fn open(path: &str) -> Option<Self> {
        let file = OpenOptions::new().read(true).write(true).open(path).ok()?;
        if file.metadata().ok()?.len() < (SLOTS * 4) as u64 {
            return None;
        }
        // SAFETY: a shared mapping of SLOTS 32-bit words of a file at least that long; it stays mapped for the life of the process (the descriptor may close)
        let p = unsafe { libc::mmap(std::ptr::null_mut(), SLOTS * 4, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, file.as_raw_fd(), 0) };
        if p == libc::MAP_FAILED {
            return None;
        }
        let base = p as *const AtomicU32;
        let seen = (0..SLOTS).map(|i| unsafe { (*base.add(i)).load(Ordering::Acquire) }).collect();
        Some(Self { base, seen })
    }

    fn word(&self, i: usize) -> &AtomicU32 {
        // SAFETY: i < SLOTS, within the mapping
        unsafe { &*self.base.add(i) }
    }

    /// Whether another process committed to `table` since this one last asked.
    pub fn changed(&mut self, table: &str) -> bool {
        let i = slot(table);
        let now = self.word(i).load(Ordering::Acquire);
        if now == self.seen[i] {
            return false;
        }
        self.seen[i] = now;
        true
    }

    /// This process committed a write to `table`.
    pub fn bump(&mut self, table: &str) {
        let i = slot(table);
        let before = self.word(i).fetch_add(1, Ordering::AcqRel);
        // its own bump is not news to it; another's, in between, still is
        if before == self.seen[i] {
            self.seen[i] = before.wrapping_add(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bump_by_one_is_seen_by_the_other_and_not_by_itself() {
        let path = std::env::temp_dir().join(format!("afx-epochs-{}", std::process::id()));
        std::fs::write(&path, vec![0u8; SLOTS * 4]).unwrap();
        let p = path.to_str().unwrap();
        let (mut a, mut b) = (Epochs::open(p).unwrap(), Epochs::open(p).unwrap());
        assert!(!a.changed("notes") && !b.changed("notes"));
        a.bump("notes");
        assert!(!a.changed("notes")); // its own
        assert!(b.changed("notes"));
        assert!(!b.changed("notes")); // once
        b.bump("notes");
        a.bump("notes");
        assert!(a.changed("notes")); // b's, in between its own
        assert!(!a.changed("other") && !b.changed("other"));
        let _ = std::fs::remove_file(path);
    }
}
