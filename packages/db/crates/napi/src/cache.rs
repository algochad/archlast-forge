//! The read cache: the text of document reads, by statement and parameters, kept exactly up to date. Only valid in a process that is the database's only
//! writer (the local SQLite database with one function runtime): every write goes through this engine.
//!
//! Never stale, by construction (the rules are the JavaScript cache's, which this replaces):
//! - a table with uncommitted writes (a mutation running, or a group-commit batch not yet committed) is `pending`: nothing is read from or stored for it until
//!   those writes commit or roll back; then the entries whose topics they wrote are dropped;
//! - a read uses an entry only if its table wasn't invalidated after the reading transaction's snapshot, and stores one under the same rule;
//! - a read-only transaction that used cached text and then needs the database after a commit landed re-runs (`SnapshotMoved`), so one query never mixes two states.

use lru::LruCache;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

struct Entry {
    table: Rc<str>,
    text: Rc<str>,
    topics: Rc<[String]>,
    size: usize,
}

/// A cached read: its text, and the topics it read (a transaction that uses it has read them too).
pub struct Hit {
    pub text: Rc<str>,
    pub topics: Rc<[String]>,
}

pub struct ReadCache {
    entries: LruCache<String, Entry>,
    by_topic: HashMap<String, HashSet<String>>,
    /// The keys read from each table, for dropping them when another process commits to it.
    by_table: HashMap<String, HashSet<String>>,
    /// When each table was last invalidated, on a counter shared by all tables.
    invalidated_at: HashMap<String, u64>,
    /// Tables with writes not yet committed or rolled back, and how many transactions hold them.
    pending: HashMap<String, u32>,
    clock: u64,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
    pub enabled: bool,
}

impl ReadCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self { entries: LruCache::unbounded(), by_topic: HashMap::new(), by_table: HashMap::new(), invalidated_at: HashMap::new(), pending: HashMap::new(), clock: 0, bytes: 0, max_entries, max_bytes, enabled: true }
    }

    /// The current point on the invalidation counter: a transaction's snapshot stamp.
    pub fn now(&self) -> u64 {
        self.clock
    }

    fn usable(&self, table: &str, stamp: u64) -> bool {
        !self.pending.contains_key(table) && self.invalidated_at.get(table).copied().map(|t| t <= stamp).unwrap_or(true)
    }

    pub fn get(&mut self, key: &str, table: &str, stamp: u64) -> Option<Hit> {
        if !self.enabled || !self.usable(table, stamp) {
            return None;
        }
        self.entries.get(key).map(|e| Hit { text: e.text.clone(), topics: e.topics.clone() })
    }

    pub fn set(&mut self, key: String, table: &str, text: Rc<str>, stamp: u64, topics: &[String]) {
        if !self.enabled || !self.usable(table, stamp) {
            return;
        }
        let size = 64 + topics.len() * 32 + text.len() + key.len();
        if size > self.max_bytes / 8 {
            return;
        }
        self.remove(&key);
        for t in topics {
            self.by_topic.entry(t.clone()).or_default().insert(key.clone());
        }
        self.by_table.entry(table.to_string()).or_default().insert(key.clone());
        self.bytes += size;
        self.entries.put(key, Entry { text, topics: Rc::from(topics), size, table: table.into() });
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some((k, e)) = self.entries.pop_lru() else { break };
            self.unlink(&k, &e);
        }
    }

    /// A transaction is about to write `table` (once per transaction and table): until it settles, the table is off limits.
    pub fn writing(&mut self, table: &str) {
        *self.pending.entry(table.to_string()).or_insert(0) += 1;
        self.clock += 1;
        self.invalidated_at.insert(table.to_string(), self.clock);
    }

    /// Drops every entry, after a write too broad to name its topics (a restore).
    pub fn clear(&mut self) {
        self.entries.clear();
        self.by_topic.clear();
        self.by_table.clear();
        self.bytes = 0;
    }

    /// Another process committed to `table`, and which topics it wrote is not known: everything read from the table is dropped, and the table counts as written now.
    pub fn external(&mut self, table: &str) {
        self.clock += 1;
        self.invalidated_at.insert(table.to_string(), self.clock);
        for key in self.by_table.remove(table).unwrap_or_default() {
            if let Some(e) = self.entries.pop(&key) {
                self.unlink(&key, &e);
            }
        }
    }

    /// That transaction committed or rolled back; `topics` are those it wrote (a rolled-back one may pass them too: dropping more is safe).
    pub fn settled<'a>(&mut self, table: &str, topics: impl Iterator<Item = &'a String>) {
        match self.pending.get(table).copied().unwrap_or(1).saturating_sub(1) {
            0 => {
                self.pending.remove(table);
            }
            n => {
                self.pending.insert(table.to_string(), n);
            }
        }
        self.clock += 1;
        self.invalidated_at.insert(table.to_string(), self.clock);
        for t in topics {
            if let Some(keys) = self.by_topic.get(t).cloned() {
                for key in keys {
                    self.remove(&key);
                }
            }
        }
    }

    fn remove(&mut self, key: &str) {
        if let Some(e) = self.entries.pop(key) {
            self.unlink(key, &e);
        }
    }

    fn unlink(&mut self, key: &str, e: &Entry) {
        self.bytes = self.bytes.saturating_sub(e.size);
        if let Some(keys) = self.by_table.get_mut(&*e.table) {
            keys.remove(key);
            if keys.is_empty() {
                self.by_table.remove(&*e.table);
            }
        }
        for t in e.topics.iter() {
            if let Some(keys) = self.by_topic.get_mut(t) {
                keys.remove(key);
                if keys.is_empty() {
                    self.by_topic.remove(t);
                }
            }
        }
    }
}
