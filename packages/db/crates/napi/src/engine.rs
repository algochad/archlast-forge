//! The document engine: the database's connections, its transactions, and the operations on documents. JavaScript describes the schema (once, at `migrate`) and
//! sends validated documents and query descriptions; the engine plans, runs and answers with JSON text, keeps the reactivity topics of what each transaction read
//! and wrote, and the cache of reads that makes a repeated one never reach the database.

use crate::cache::ReadCache;
use crate::jsjson;
use crate::plan::{self, Desc};
use crate::schema::{index_body, safe_field, table_ddl, Schema, TableSpec};
use crate::sqlio::{docs_text, rows_text};
use rusqlite::types::Value as Sql;
use rusqlite::{params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod ops;

/// What went wrong, as JavaScript tells apart: bad input (a ValidationError), a read that has to start over, or anything else.
#[derive(Debug)]
pub enum E {
    Validation(String),
    /// The engine cannot vouch for a write (a rule it doesn't check, or a value that fails one): JavaScript's schema decides, and words the error.
    NeedsJs,
    SnapshotMoved,
    Other(String),
}

impl From<rusqlite::Error> for E {
    fn from(e: rusqlite::Error) -> Self {
        E::Other(e.to_string())
    }
}

pub type R<T> = Result<T, E>;

fn v(msg: impl Into<String>) -> E {
    E::Validation(msg.into())
}

pub struct Options {
    pub readers: usize,
    pub mmap_bytes: Option<i64>,
    pub cache_kib: Option<i64>,
    pub cache_entries: usize,
    pub cache_bytes: usize,
    /// The file of commit counters shared with the other processes using the database (a cluster), when there are some.
    pub epochs: Option<String>,
}

enum Kind {
    Read(usize),
    Write,
}

struct Tx {
    kind: Kind,
    /// A reader's BEGIN is issued at its first statement, so a read answered from the cache costs no BEGIN or COMMIT.
    begun: bool,
    /// Whether this transaction may read the cache (the last tries of a read that keeps being moved go straight to the database).
    cached: bool,
    reads: Vec<String>,
    read_set: HashSet<String>,
    writes: Vec<String>,
    write_set: HashSet<String>,
    /// Tables this transaction marked pending in the cache; settled when it ends.
    writing: HashSet<String>,
    stamp: u64,
    used_cache: bool,
    used_db: bool,
    dirty: bool,
}

pub struct Ended {
    pub reads: Vec<String>,
    pub writes: Vec<String>,
}

/// What a description of a range plans to, kept by its text.
pub struct Planned {
    pub sql: String,
    pub params: Vec<rusqlite::types::Value>,
    /// What the statement reads, as a topic.
    pub read: String,
    /// The fields a `select` keeps.
    pub projection: Option<Vec<String>>,
    /// No related documents to add: the answer is the statement's rows as they come (cut down to the projection).
    pub plain: bool,
}

pub struct Engine {
    writer: Connection,
    readers: Vec<Connection>,
    free: Vec<usize>,
    schema: Rc<Schema>,
    cache: ReadCache,
    txs: Vec<Option<Tx>>,
    free_txs: Vec<usize>,
    last_creation: f64,
    /// The statement a description plans to (its text, parameters and the topic it reads), kept by the description's text: a read that cannot come from the result cache
    /// (a write transaction's, a changed snapshot's) skips parsing, planning and building the statement.
    plans: HashMap<String, Rc<Planned>>,
    epochs: Option<crate::epochs::Epochs>,
    /// Reads answered from the cache, and reads that reached the database.
    pub hits: u64,
    pub misses: u64,
}

/// `table:index:[values]`, the key of what a statement read or a write touched.
pub fn topic(table: &str, index: &str, values: &[Value]) -> String {
    let mut s = format!("{table}:{index}:[");
    for (i, x) in values.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        jsjson::write(&mut s, x);
    }
    s.push(']');
    s
}

fn open(path: &str, o: &Options, reader: bool) -> R<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let c = Connection::open_with_flags(path, flags)?;
    c.set_prepared_statement_cache_capacity(512);
    c.busy_timeout(Duration::from_millis(5000))?;
    c.execute_batch("PRAGMA wal_autocheckpoint = 0")?;
    if let Some(m) = o.mmap_bytes {
        c.execute_batch(&format!("PRAGMA mmap_size = {m}"))?;
    }
    if let Some(k) = o.cache_kib {
        c.execute_batch(&format!("PRAGMA cache_size = -{k}; PRAGMA temp_store = MEMORY"))?;
    }
    if reader {
        c.execute_batch("PRAGMA query_only = ON")?;
    }
    Ok(c)
}

thread_local! {
    /// Random bytes from the operating system, fetched 4 KiB at a time: a system call per id was a quarter of an insert.
    static RANDOM: std::cell::RefCell<(Box<[u8; 4096]>, usize)> = std::cell::RefCell::new((Box::new([0u8; 4096]), 4096));
}

#[cfg(test)]
pub fn new_id_for_bench(table: &str) -> String {
    new_id(table)
}

fn new_id(table: &str) -> String {
    // A version 7 UUID's layout: the time in milliseconds first, then random bits. Ids made one after another are then close in the `_id` index (and in the order of the
    // table), where random ones land all over it: an insert into a large table touches one page, not a different one each time. They are 32 hex digits as before.
    let mut b = [0u8; 16];
    RANDOM.with(|r| {
        let (pool, at) = &mut *r.borrow_mut();
        if *at + 16 > pool.len() {
            getrandom::getrandom(&mut pool[..]).expect("random bytes");
            *at = 0;
        }
        b.copy_from_slice(&pool[*at..*at + 16]);
        *at += 16;
    });
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(table.len() + 33);
    s.push_str(table);
    s.push(':');
    for x in b {
        s.push(HEX[(x >> 4) as usize] as char);
        s.push(HEX[(x & 15) as usize] as char);
    }
    s
}

/// `table:index:[values]` for the first fields of an index, read from the document, without making a list of the values.
fn index_topic(table: &str, index: &str, fields: &[String], doc: &Value) -> String {
    let mut s = String::with_capacity(table.len() + index.len() + 16 * fields.len() + 4);
    s.push_str(table);
    s.push(':');
    s.push_str(index);
    s.push_str(":[");
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        match doc.get(f) {
            Some(x) => jsjson::write(&mut s, x),
            None => s.push_str("null"),
        }
    }
    s.push(']');
    s
}

fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a == b || (matches!(a, Value::Object(_) | Value::Array(_)) && jsjson::stringify(a) == jsjson::stringify(b)),
        _ => false,
    }
}

impl Engine {
    fn stmts<'a>(schema: &'a Schema, table: &str) -> R<&'a crate::schema::Stmts> {
        schema.tables.get(table).map(|t| &t.stmts).ok_or_else(|| v(format!("Unknown table \"{table}\"")))
    }

    #[cfg(test)]
    pub fn writer_conn(&self) -> &Connection {
        &self.writer
    }

    pub fn open(path: &str, o: &Options) -> R<Self> {
        let writer = open(path, o, false)?;
        writer.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 67108864")?;
        let readers = (0..o.readers).map(|_| open(path, o, true)).collect::<R<Vec<_>>>()?;
        let free = (0..readers.len()).rev().collect();
        Ok(Self { writer, readers, free, schema: Rc::new(Schema::default()), cache: ReadCache::new(o.cache_entries, o.cache_bytes), txs: Vec::new(), free_txs: Vec::new(), last_creation: 0.0, plans: HashMap::new(), epochs: o.epochs.as_deref().and_then(crate::epochs::Epochs::open), hits: 0, misses: 0 })
    }

    pub fn set_cache(&mut self, on: bool) {
        self.cache.enabled = on;
        if !on {
            self.cache.clear();
        }
    }

    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }

    // ---- schema ----

    /// Makes the tables, their indexes and their search tables what the schema says, in one transaction, and remembers the schema for the operations that follow.
    pub fn migrate(&mut self, tables: Vec<TableSpec>) -> R<()> {
        let c = &self.writer;
        c.execute_batch("BEGIN IMMEDIATE")?;
        let done = (|| -> R<()> {
            c.execute_batch("CREATE TABLE IF NOT EXISTS \"_search_indexes\" (\"name\" TEXT PRIMARY KEY, \"table\" TEXT NOT NULL, \"field\" TEXT NOT NULL)")?;
            for t in &tables {
                c.execute_batch(&table_ddl(&t.name))?;
                let mut plan: Vec<(String, String)> = vec![(t.creation.sql.clone(), index_body(&t.name, &[]))];
                plan.extend(t.indexes.iter().map(|(_, i)| (i.sql.clone(), index_body(&t.name, &i.fields))));
                let existing: Vec<String> = {
                    let mut st = c.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1")?;
                    let rows = st.query_map([&t.name], |r| r.get::<_, String>(0))?;
                    rows.collect::<Result<Vec<_>, _>>()?.into_iter().filter(|n| n.starts_with("afx_")).collect()
                };
                for name in &existing {
                    if !plan.iter().any(|(n, _)| n == name) {
                        c.execute_batch(&format!("DROP INDEX IF EXISTS \"{name}\""))?;
                    }
                }
                for (name, body) in &plan {
                    if !existing.contains(name) {
                        c.execute_batch(&format!("CREATE INDEX IF NOT EXISTS \"{name}\" {body}"))?;
                    }
                }
                let registered: Vec<(String, String)> = {
                    let mut st = c.prepare("SELECT \"name\", \"field\" FROM \"_search_indexes\" WHERE \"table\" = ?1")?;
                    let rows = st.query_map([&t.name], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                    rows.collect::<Result<Vec<_>, _>>()?
                };
                for (name, field) in &registered {
                    if !t.search.iter().any(|(_, s)| &s.fts == name && &s.field == field) {
                        c.execute_batch(&format!("DROP TABLE IF EXISTS \"{name}\""))?;
                        c.execute("DELETE FROM \"_search_indexes\" WHERE \"name\" = ?1", [name])?;
                    }
                }
                for (_, s) in &t.search {
                    if registered.iter().any(|(n, f)| n == &s.fts && f == &s.field) {
                        continue;
                    }
                    if !safe_field(&s.field) {
                        return Err(v(format!("{:?} is not a field name", s.field)));
                    }
                    c.execute_batch(&format!("CREATE VIRTUAL TABLE \"{}\" USING fts5(doc_id UNINDEXED, body, tokenize = 'unicode61')", s.fts))?;
                    let f = crate::schema::field_expr(&s.field);
                    c.execute_batch(&format!("INSERT INTO \"{}\" (doc_id, body) SELECT \"_id\", {f} FROM \"{}\" WHERE {f} IS NOT NULL", s.fts, t.name))?;
                    c.execute("INSERT INTO \"_search_indexes\" (\"name\", \"table\", \"field\") VALUES (?1, ?2, ?3)", [&s.fts, &t.name, &s.field])?;
                }
            }
            Ok(())
        })();
        match done {
            Ok(()) => c.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = c.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
        self.schema = Rc::new(Schema { tables: tables.into_iter().map(|mut t| (t.stmts = crate::schema::Stmts::of(&t.name), (t.name.clone(), Rc::new(t))).1).collect() });
        self.cache.clear();
        self.plans.clear();
        Ok(())
    }

    // ---- transactions ----

    fn add_tx(&mut self, tx: Tx) -> usize {
        match self.free_txs.pop() {
            Some(i) => {
                self.txs[i] = Some(tx);
                i
            }
            None => {
                self.txs.push(Some(tx));
                self.txs.len() - 1
            }
        }
    }

    fn new_tx(&self, kind: Kind, cached: bool) -> Tx {
        Tx { kind, begun: false, cached, reads: vec![], read_set: HashSet::new(), writes: vec![], write_set: HashSet::new(), writing: HashSet::new(), stamp: self.cache.now(), used_cache: false, used_db: false, dirty: false }
    }

    /// A read transaction on a reader connection; None when every reader is in use (the caller waits for one to be released).
    pub fn begin_read(&mut self, cached: bool) -> Option<usize> {
        let r = self.free.pop()?;
        let tx = self.new_tx(Kind::Read(r), cached);
        Some(self.add_tx(tx))
    }

    /// The state of one function's writes inside the writer's transaction (the caller runs BEGIN, the savepoints and COMMIT with `writer_sql`).
    pub fn begin_write(&mut self) -> usize {
        let tx = self.new_tx(Kind::Write, true);
        self.add_tx(tx)
    }

    /// Runs a statement of the writer's transaction control: BEGIN IMMEDIATE, SAVEPOINT g, RELEASE g, ROLLBACK TO g, COMMIT, ROLLBACK.
    pub fn writer_sql(&self, sql: &str) -> R<()> {
        self.writer.prepare_cached(sql)?.execute([])?;
        Ok(())
    }

    /// `BEGIN IMMEDIATE` on the writer without waiting: false when another process holds the write lock (the caller waits without blocking its event loop and tries
    /// again), where SQLite's own busy handler would sleep in this call.
    pub fn writer_begin(&self) -> R<bool> {
        self.writer.busy_timeout(Duration::ZERO)?;
        let r = self.writer.prepare_cached("BEGIN IMMEDIATE").and_then(|mut s| s.execute([]));
        self.writer.busy_timeout(Duration::from_millis(5000))?;
        match r {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(e, _)) if matches!(e.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub fn writer_in_transaction(&self) -> bool {
        !self.writer.is_autocommit()
    }

    pub fn end_tx(&mut self, id: usize, ok: bool) -> R<Ended> {
        let mut tx = self.txs.get_mut(id).and_then(Option::take).ok_or_else(|| E::Other("unknown transaction".into()))?;
        self.free_txs.push(id);
        match tx.kind {
            Kind::Read(r) => {
                if tx.begun {
                    let c = &self.readers[r];
                    let sql = if ok { "COMMIT" } else { "ROLLBACK" };
                    if !c.is_autocommit() {
                        c.prepare_cached(sql)?.execute([])?;
                    }
                }
                self.free.push(r);
            }
            Kind::Write => {
                // Committed or rolled back: the tables it wrote can be read and cached again.
                for t in std::mem::take(&mut tx.writing) {
                    self.cache.settled(&t, tx.writes.iter());
                    // and the other processes are told of a commit before the writer is answered
                    if ok {
                        if let Some(e) = &mut self.epochs {
                            e.bump(&t);
                        }
                    }
                }
            }
        }
        Ok(Ended { reads: tx.reads, writes: tx.writes })
    }

    fn tx_mut(txs: &mut [Option<Tx>], id: usize) -> R<&mut Tx> {
        txs.get_mut(id).and_then(Option::as_mut).ok_or_else(|| E::Other("unknown transaction".into()))
    }

    /// Before a statement runs on a reader: its BEGIN, once.
    fn begin_if_needed(c: &Connection, tx: &mut Tx) -> R<()> {
        if matches!(tx.kind, Kind::Read(_)) && !tx.begun {
            c.prepare_cached("BEGIN")?.execute([])?;
            tx.begun = true;
        }
        Ok(())
    }

    /// Before a statement goes to the database: a read-only transaction that used cached text and finds that something committed since starts over.
    fn to_db(&self, tx: &mut Tx) -> R<()> {
        if self.cache.enabled && tx.cached && !tx.dirty && !tx.used_db && matches!(tx.kind, Kind::Read(_)) {
            if tx.used_cache && self.cache.now() != tx.stamp {
                return Err(E::SnapshotMoved);
            }
            tx.stamp = self.cache.now();
        }
        tx.used_db = true;
        Ok(())
    }

    fn read_topic(tx: &mut Tx, t: &str) {
        if tx.read_set.insert(t.to_string()) {
            tx.reads.push(t.to_string());
        }
    }

    // ---- raw statements (the engine's own tables, and what the planner does not cover) ----

    pub fn all(&mut self, id: usize, sql: &str, params: Vec<Sql>) -> R<String> {
        let tx = Self::tx_mut(&mut self.txs, id)?;
        let c = match tx.kind {
            Kind::Read(r) => &self.readers[r],
            Kind::Write => &self.writer,
        };
        Self::begin_if_needed(c, tx)?;
        Ok(rows_text(c, sql, params)?)
    }

    pub fn run(&mut self, id: usize, sql: &str, params: Vec<Sql>) -> R<usize> {
        let tx = Self::tx_mut(&mut self.txs, id)?;
        let c = match tx.kind {
            Kind::Read(r) => &self.readers[r],
            Kind::Write => &self.writer,
        };
        Self::begin_if_needed(c, tx)?;
        Ok(c.prepare_cached(sql)?.execute(params_from_iter(params))?)
    }

    /// Rows of a statement that the planner does not write (joins, statistics, search), by the cache like any read: `topics` is what it read.
    pub fn select(&mut self, id: usize, table: &str, sql: &str, params: Vec<Sql>, topics: &[String], key_params: &str) -> R<Rc<str>> {
        self.cached(id, table, format!("S\0{sql}\0{key_params}"), |c| Ok((rows_text(c, sql, params)?, topics.to_vec())))
    }

    /// The cache's rule for every read: from the cache if it has the text as of this transaction's snapshot, else from the database, and kept. `key` names the read
    /// (JavaScript's own description of it, so a cached read is found without planning anything); `make` runs it and says what it read.
    fn cached(&mut self, id: usize, table: &str, key: String, make: impl FnOnce(&Connection) -> R<(String, Vec<String>)>) -> R<Rc<str>> {
        let mut tx = self.txs.get_mut(id).and_then(Option::take).ok_or_else(|| E::Other("unknown transaction".into()))?;
        let result = self.cached_in(&mut tx, table, key, make);
        self.txs[id] = Some(tx);
        result
    }

    fn cached_in(&mut self, tx: &mut Tx, table: &str, key: String, make: impl FnOnce(&Connection) -> R<(String, Vec<String>)>) -> R<Rc<str>> {
        // another process may have committed to the table: what was read from it is then gone (and a transaction that used it starts over)
        if let Some(e) = &mut self.epochs {
            if e.changed(table) {
                self.cache.external(table);
            }
        }
        if self.cache.enabled && tx.cached && !tx.dirty {
            if let Some(hit) = self.cache.get(&key, table, tx.stamp) {
                tx.used_cache = true;
                self.hits += 1;
                for t in hit.topics.iter() {
                    Self::read_topic(tx, t);
                }
                return Ok(hit.text);
            }
        }
        self.to_db(tx)?;
        self.misses += 1;
        let c = match tx.kind {
            Kind::Read(r) => &self.readers[r],
            Kind::Write => &self.writer,
        };
        Self::begin_if_needed(c, tx)?;
        let (text, topics) = make(c)?;
        for t in &topics {
            Self::read_topic(tx, t);
        }
        let text: Rc<str> = Rc::from(text);
        if self.cache.enabled && tx.cached && !tx.dirty {
            self.cache.set(key, table, text.clone(), tx.stamp, &topics);
        }
        Ok(text)
    }

    // ---- reads ----

    fn table(&self, name: &str) -> R<&TableSpec> {
        self.schema.tables.get(name).map(|t| &**t).ok_or_else(|| v(format!("Unknown table \"{name}\"")))
    }

    fn parse_id<'a>(&self, id: &'a str) -> R<&'a str> {
        let i = id.find(':').ok_or_else(|| v(format!("Invalid id {}", jsjson::stringify(&Value::String(id.to_string())))))?;
        let table = &id[..i];
        self.table(table)?;
        Ok(table)
    }

    /// One document, as JSON text, or None.
    pub fn get(&mut self, tx: usize, id: &str) -> R<Option<String>> {
        let table = self.parse_id(id)?.to_string();
        let topic = topic(&table, "by_id", &[Value::String(id.to_string())]);
        let sql = format!("SELECT \"_id\", \"_creationTime\", \"doc\" FROM \"{table}\" WHERE \"_id\" = ?1");
        let text = self.cached(tx, &table, format!("G\0{id}"), |c| Ok((docs_text(c, &sql, vec![Sql::Text(id.to_string())])?, vec![topic])))?;
        Ok(if &*text == "[]" { None } else { Some(text[1..text.len() - 1].to_string()) })
    }

    /// Documents by id, in the order asked for, `null` where one doesn't exist. Ids may belong to different tables.
    pub fn get_many(&mut self, tx: usize, ids: &[String]) -> R<String> {
        let mut found: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut by_table: Vec<(String, Vec<String>)> = Vec::new();
        for id in ids {
            let t = self.parse_id(id)?.to_string();
            match by_table.iter_mut().find(|(n, _)| n == &t) {
                Some((_, list)) => {
                    if !list.contains(id) {
                        list.push(id.clone())
                    }
                }
                None => by_table.push((t, vec![id.clone()])),
            }
        }
        for (table, list) in by_table {
            for chunk in list.chunks(500) {
                let topics: Vec<String> = chunk.iter().map(|id| topic(&table, "by_id", &[Value::String(id.clone())])).collect();
                let sql = format!("SELECT \"_id\", \"_creationTime\", \"doc\" FROM \"{table}\" WHERE \"_id\" IN ({})", chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", "));
                let key = format!("M\0{}", chunk.join("\0"));
                let params: Vec<Sql> = chunk.iter().map(|s| Sql::Text(s.clone())).collect();
                let text = self.cached(tx, &table, key, |c| Ok((docs_text(c, &sql, params)?, topics)))?;
                let docs: Vec<Value> = serde_json::from_str(&text).map_err(|e| E::Other(e.to_string()))?;
                for d in docs {
                    if let Some(id) = d.get("_id").and_then(Value::as_str) {
                        found.insert(id.to_string(), jsjson::stringify(&d));
                    }
                }
            }
        }
        let mut out = String::from("[");
        for (i, id) in ids.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(found.get(id).map(String::as_str).unwrap_or("null"));
        }
        out.push(']');
        Ok(out)
    }

    /// The documents of a range, as JSON text (an array). `desc` is JavaScript's description of the range (JSON): it is also the cache's key, so the planner runs only on a miss.
    pub fn query(&mut self, tx: usize, table: &str, desc: &str) -> R<Rc<str>> {
        self.table(table)?;
        let key = format!("Q\0{desc}");
        let known = self.plans.get(desc).cloned();
        let mut made = None;
        let schema = self.schema.clone();
        let result = self.cached(tx, table, key, |c| {
            let planned = match known {
                Some(p) => p,
                None => {
                    let p = Self::plan_of(&schema, desc)?;
                    made = Some(p.clone());
                    p
                }
            };
            Ok((docs_text(c, &planned.sql, planned.params.clone())?, vec![planned.read.clone()]))
        });
        if let Some(p) = made {
            self.keep_plan(desc, p);
        }
        result
    }

    /// Parses and plans a description.
    fn plan_of(schema: &Schema, desc: &str) -> R<Rc<Planned>> {
        let d: Desc = serde_json::from_str(desc).map_err(|e| E::Other(e.to_string()))?;
        let spec = schema.tables.get(&d.table).ok_or_else(|| v(format!("Unknown table \"{}\"", d.table)))?;
        let p = plan::plan(spec, &d).map_err(v)?;
        let sql = plan::select_sql(&d, &p);
        Ok(Rc::new(Planned { sql, params: p.params, read: p.read, projection: d.projection, plain: d.includes.is_empty() }))
    }

    fn keep_plan(&mut self, desc: &str, p: Rc<Planned>) {
        if self.plans.len() >= 4096 {
            self.plans.clear();
        }
        self.plans.insert(desc.to_string(), p);
    }

    /// The plan of a description, made on the first sight of its text.
    pub(crate) fn planned(&mut self, desc: &str) -> R<Rc<Planned>> {
        if let Some(p) = self.plans.get(desc) {
            return Ok(p.clone());
        }
        let p = Self::plan_of(&self.schema, desc)?;
        self.keep_plan(desc, p.clone());
        Ok(p)
    }

    /// The same for a description already parsed (and a key made by the caller, who changed the description).
    fn query_key(&mut self, tx: usize, table: &str, key: String, d: &Desc) -> R<Rc<str>> {
        let spec = self.schema.tables.get(table).cloned().ok_or_else(|| v(format!("Unknown table \"{table}\"")))?;
        self.cached(tx, table, key, |c| {
            let p = plan::plan(&spec, d).map_err(v)?;
            let sql = plan::select_sql(d, &p);
            Ok((docs_text(c, &sql, p.params)?, vec![p.read]))
        })
    }

    /// How many documents the range holds.
    pub fn count(&mut self, tx: usize, table: &str, desc: &str) -> R<f64> {
        self.table(table)?;
        let key = format!("C\0{desc}");
        let schema = self.schema.clone();
        let text = self.cached(tx, table, key, |c| {
            let d: Desc = serde_json::from_str(desc).map_err(|e| E::Other(e.to_string()))?;
            let spec = schema.tables.get(&d.table).ok_or_else(|| v(format!("Unknown table \"{}\"", d.table)))?;
            let p = plan::plan(spec, &d).map_err(v)?;
            let sql = format!("SELECT COUNT(*) AS \"n\" FROM \"{}\" {}", d.table, p.where_sql);
            Ok((rows_text(c, &sql, p.params)?, vec![p.read]))
        })?;
        let rows: Vec<Value> = serde_json::from_str(&text).map_err(|e| E::Other(e.to_string()))?;
        Ok(rows.first().and_then(|r| r.get("n")).and_then(Value::as_f64).unwrap_or(0.0))
    }

    /// The statement and parameters of a range (for the query-plan warnings of development).
    pub fn plan_sql(&self, d: &Desc) -> R<(String, Vec<Sql>)> {
        let table = self.table(&d.table)?;
        let p = plan::plan(table, d).map_err(v)?;
        Ok((plan::select_sql(d, &p), p.params))
    }

    // ---- writes ----

    fn writable(tx: &Tx) -> R<()> {
        if matches!(tx.kind, Kind::Read(_)) {
            return Err(E::Other("Database is read-only in queries".into()));
        }
        Ok(())
    }

    fn creation_time(&mut self) -> f64 {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
        self.last_creation = now.max(self.last_creation + 0.001);
        self.last_creation
    }

    /// A write to the document `id` (its fields are `doc`) has happened: the table and its topics are written. When `before` is the document it replaced, its topics are added too,
    /// but only for the index prefixes whose values the change touched: a prefix both versions share is one topic.
    fn written(&mut self, tx_id: usize, table: &str, id: &str, doc: &Value, before: Option<&Value>) -> R<()> {
        let spec = self.schema.tables.get(table).ok_or_else(|| v(format!("Unknown table \"{table}\"")))?;
        let tx = Self::tx_mut(&mut self.txs, tx_id)?;
        // From here this transaction reads its own uncommitted writes, so only from the database; and nobody may use the table until it settles.
        tx.dirty = true;
        if !tx.writing.contains(table) {
            tx.writing.insert(table.to_string());
            self.cache.writing(table);
        }
        let mut add = |t: String| {
            if !tx.write_set.contains(&t) {
                tx.write_set.insert(t.clone());
                tx.writes.push(t);
            }
        };
        add(table.to_string());
        let mut by_id = String::with_capacity(table.len() + id.len() + 12);
        by_id.push_str(table);
        by_id.push_str(":by_id:[");
        jsjson::write_str(&mut by_id, id);
        by_id.push(']');
        add(by_id);
        for (name, idx) in &spec.indexes {
            let mut shared = before.is_some();
            for k in 1..=idx.fields.len() {
                let f = &idx.fields[k - 1];
                if shared && !same(doc.get(f), before.and_then(|b| b.get(f))) {
                    shared = false;
                }
                add(index_topic(table, name, &idx.fields[..k], doc));
                if let Some(b) = before {
                    if !shared {
                        add(index_topic(table, name, &idx.fields[..k], b));
                    }
                }
            }
        }
        Ok(())
    }

    /// Keeps a document's search indexes in step with it; `text` per index is its search field's value if that is a string.
    fn sync_search(&self, table: &str, id: &str, doc: Option<&Value>) -> R<()> {
        let spec = self.table(table)?;
        for (_, s) in &spec.search {
            let text = doc.and_then(|d| d.get(&s.field)).and_then(Value::as_str);
            self.writer.prepare_cached(&format!("DELETE FROM \"{}\" WHERE doc_id = ?1", s.fts))?.execute([id])?;
            if let Some(t) = text {
                self.writer.prepare_cached(&format!("INSERT INTO \"{}\" (doc_id, body) VALUES (?1, ?2)", s.fts))?.execute([id, t])?;
            }
        }
        Ok(())
    }

    /// The text a document is stored as, once it is known to be valid: `value` is the user's document as JSON; a loose table drops `_id` and `_creationTime` and keeps the rest.
    /// `trusted`: JavaScript has validated it already. Else the schema's validators are checked here, and what they cannot vouch for goes back to JavaScript.
    fn prepare(&self, table: &str, map: serde_json::Map<String, Value>, max_bytes: usize, trusted: bool, original: Option<&str>) -> R<(String, serde_json::Map<String, Value>)> {
        let t = self.table(table)?;
        let mut map = map;
        let mut changed = false;
        match t.strict {
            Some(false) => changed = map.remove("_id").is_some() | map.remove("_creationTime").is_some(),
            Some(true) if trusted => {}
            Some(true) => match &t.fields {
                Some(fields) if crate::validate::object_accepts(fields, &map) => {}
                _ => return Err(E::NeedsJs),
            },
            None if trusted => changed = map.remove("_id").is_some() | map.remove("_creationTime").is_some(),
            None => return Err(E::NeedsJs),
        }
        let text = match original {
            Some(o) if !changed => o.to_string(),
            _ => jsjson::stringify_map(&map),
        };
        let len: usize = if text.is_ascii() { text.len() } else { text.chars().map(char::len_utf16).sum() };
        if len > max_bytes {
            return Err(v(format!("Document in \"{table}\" is {len} bytes; the limit is {max_bytes} (MAX_DOCUMENT_BYTES)")));
        }
        Ok((text, map))
    }

    /// Inserts documents (each the JSON text of the user's value): validated, given ids and creation times, written, indexed for search, and their topics kept. All of them are
    /// checked before any is written. The new ids, in order.
    pub fn insert(&mut self, tx_id: usize, table: &str, docs: &[String], max_bytes: usize, trusted: bool) -> R<Vec<String>> {
        Self::writable(Self::tx_mut(&mut self.txs, tx_id)?)?;
        self.table(table)?;
        let mut prepared: Vec<(String, serde_json::Map<String, Value>)> = Vec::with_capacity(docs.len());
        for json in docs {
            let map = match serde_json::from_str::<Value>(json) {
                Ok(Value::Object(m)) => m,
                _ => return Err(E::NeedsJs),
            };
            prepared.push(self.prepare(table, map, max_bytes, trusted, Some(json))?);
        }
        let mut ids = Vec::with_capacity(prepared.len());
        for (text, map) in prepared {
            let id = new_id(table);
            let time = self.creation_time();
            self.writer.prepare_cached(&Self::stmts(&self.schema, &table)?.insert)?.execute(rusqlite::params![id, time, text])?;
            let doc = Value::Object(map);
            self.sync_search(table, &id, Some(&doc))?;
            self.written(tx_id, table, &id, &doc, None)?;
            ids.push(id);
        }
        Ok(ids)
    }

    /// Changes a document: `value` is the new fields (`replace`) or the changes to the old ones (`patch`: a field set to the `{"$undefined":true}` marker is removed). The
    /// result is validated, written, and its topics kept; false when it is stored as it is already (nothing to write, nothing to re-run).
    pub fn change(&mut self, tx_id: usize, id: &str, value: &str, patch: bool, max_bytes: usize, trusted: bool) -> R<bool> {
        Self::writable(Self::tx_mut(&mut self.txs, tx_id)?)?;
        let table = self.parse_id(id)?.to_string();
        let given = match serde_json::from_str::<Value>(value) {
            Ok(Value::Object(m)) => m,
            _ => return Err(E::NeedsJs),
        };
        let stored: String = match self.writer.prepare_cached(&Self::stmts(&self.schema, &table)?.doc)?.query_row([id], |r| r.get(0)).optional()? {
            Some(d) => d,
            None => return Err(v(format!("Document {id} not found"))),
        };
        let before: Value = serde_json::from_str(&stored).map_err(|e| E::Other(e.to_string()))?;
        let map = if patch {
            let mut merged = match &before {
                Value::Object(m) => m.clone(),
                _ => return Err(E::NeedsJs),
            };
            for (k, x) in given {
                if matches!(&x, Value::Object(m) if m.len() == 1 && m.contains_key("$undefined")) {
                    merged.shift_remove(&k);
                } else {
                    merged.insert(k, x);
                }
            }
            merged
        } else {
            given
        };
        let (text, map) = self.prepare(&table, map, max_bytes, trusted, None)?;
        if text == stored {
            return Ok(false);
        }
        self.writer.prepare_cached(&Self::stmts(&self.schema, &table)?.update)?.execute([text.as_str(), id])?;
        let doc = Value::Object(map);
        self.sync_search(&table, id, Some(&doc))?;
        self.written(tx_id, &table, id, &doc, Some(&before))?;
        Ok(true)
    }

    /// The stored fields of a document as JSON text (not its id and time), straight from the database: what a write reads before it changes a document.
    pub fn get_raw(&mut self, tx_id: usize, id: &str) -> R<Option<String>> {
        let table = self.parse_id(id)?.to_string();
        let tx = Self::tx_mut(&mut self.txs, tx_id)?;
        let c = match tx.kind {
            Kind::Read(r) => &self.readers[r],
            Kind::Write => &self.writer,
        };
        Self::begin_if_needed(c, tx)?;
        Ok(c.prepare_cached(&Self::stmts(&self.schema, &table)?.doc)?.query_row([id], |r| r.get(0)).optional()?)
    }

    /// Replaces a document's fields (the JSON text, already validated and merged); false when it is stored as it is already (nothing to write, nothing to re-run).
    /// `old` is the text it was stored as when the caller read it, if the caller has it (it was read in this transaction, so it is still what is stored).
    pub fn replace(&mut self, tx_id: usize, id: &str, json: &str, old: Option<&str>) -> R<bool> {
        Self::writable(Self::tx_mut(&mut self.txs, tx_id)?)?;
        let table = self.parse_id(id)?.to_string();
        let stored: String = match old {
            Some(o) => o.to_string(),
            None => match self.writer.prepare_cached(&Self::stmts(&self.schema, &table)?.doc)?.query_row([id], |r| r.get(0)).optional()? {
                Some(d) => d,
                None => return Err(v(format!("Document {id} not found"))),
            },
        };
        if stored == json {
            return Ok(false);
        }
        self.writer.prepare_cached(&Self::stmts(&self.schema, &table)?.update)?.execute([json, id])?;
        let doc: Value = serde_json::from_str(json).map_err(|e| E::Other(e.to_string()))?;
        let before: Value = serde_json::from_str(&stored).map_err(|e| E::Other(e.to_string()))?;
        self.sync_search(&table, id, Some(&doc))?;
        self.written(tx_id, &table, id, &doc, Some(&before))?;
        Ok(true)
    }

    /// Deletes a document (nothing if it isn't there).
    pub fn delete(&mut self, tx_id: usize, id: &str) -> R<()> {
        Self::writable(Self::tx_mut(&mut self.txs, tx_id)?)?;
        let table = self.parse_id(id)?.to_string();
        let old: Option<String> = self.writer.prepare_cached(&Self::stmts(&self.schema, &table)?.doc)?.query_row([id], |r| r.get(0)).optional()?;
        let Some(old_json) = old else { return Ok(()) };
        self.writer.prepare_cached(&Self::stmts(&self.schema, &table)?.delete)?.execute([id])?;
        let before: Value = serde_json::from_str(&old_json).map_err(|e| E::Other(e.to_string()))?;
        self.sync_search(&table, id, None)?;
        self.written(tx_id, &table, id, &before, None)?;
        Ok(())
    }

    /// A write that JavaScript made with statements of its own (a restore): the same bookkeeping as a write of the engine's.
    pub fn note_written(&mut self, tx_id: usize, table: &str, doc: &Value, before: Option<&Value>) -> R<()> {
        let id = doc.get("_id").and_then(Value::as_str).unwrap_or("");
        self.written(tx_id, table, id, doc, before)
    }
}
