//! The engine's native database layer (Node-API addon, loaded by Bun): the document database for SQLite. JavaScript keeps the schema (validators, what a field
//! may hold), the functions and the runtime; this owns the rest: tables, indexes and their migration, the connections and the write-ahead log, documents, queries,
//! the reactivity topics of what each transaction read and wrote, and the cache of reads. See engine.rs.

mod cache;
mod checkpoint;
mod engine;
mod epochs;
mod jsjson;
mod jsonscan;
mod plan;
mod schema;
mod sqlio;
mod validate;
#[cfg(test)]
mod bench;

pub(crate) use engine::topic;

use engine::{Engine as Core, Options, E};
use napi::bindgen_prelude::{Either4, Null};
use napi::Result;
use napi_derive::napi;
use rusqlite::types::Value as Sql;
use serde_json::Value;

/// How an error reaches JavaScript: the first character says which kind (1 a ValidationError, 2 a read that must start over), the rest is the message.
fn fail(e: E) -> napi::Error {
    napi::Error::from_reason(match e {
        E::Validation(m) => format!("\u{1}V{m}"),
        E::SnapshotMoved => "\u{1}S".to_string(),
        E::NeedsJs => "\u{1}X".to_string(),
        E::Other(m) => m,
    })
}

fn bad(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

/// A statement parameter as it comes from JavaScript: text, a number, a boolean or null. Booleans are 1 and 0; a number with no fraction that fits is an integer,
/// so `1.0` and `1` are the same value to an index.
pub type Param = Either4<String, f64, bool, Null>;

fn bind(params: Vec<Param>) -> Vec<Sql> {
    params
        .into_iter()
        .map(|p| match p {
            Either4::A(s) => Sql::Text(s),
            Either4::B(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => Sql::Integer(f as i64),
            Either4::B(f) => Sql::Real(f),
            Either4::C(b) => Sql::Integer(b as i64),
            Either4::D(_) => Sql::Null,
        })
        .collect()
}

#[napi]
pub struct Engine {
    core: Option<Core>,
    checkpointer: Option<checkpoint::Checkpointer>,
}

#[napi]
impl Engine {
    /// Opens the database file with a writer and `readers` readers; `options` is JSON: { readers, mmapBytes, cacheKiB, cacheEntries, cacheBytes, checkpoint, shared, epochs }.
    #[napi(constructor)]
    pub fn new(path: String, options: String) -> Result<Self> {
        let o: Value = serde_json::from_str(&options).map_err(bad)?;
        let num = |k: &str| o.get(k).and_then(Value::as_i64);
        let opts = Options {
            readers: num("readers").unwrap_or(4) as usize,
            mmap_bytes: num("mmapBytes"),
            cache_kib: num("cacheKiB"),
            cache_entries: num("cacheEntries").unwrap_or(20_000) as usize,
            cache_bytes: num("cacheBytes").unwrap_or(32 << 20) as usize,
            epochs: o.get("epochs").and_then(Value::as_str).map(String::from),
        };
        let core = Core::open(&path, &opts).map_err(fail)?;
        // `checkpoint` false: another process keeps the log; `shared`: other processes use the file (a cluster of servers)
        let flag = |k: &str, default: bool| o.get(k).and_then(Value::as_bool).unwrap_or(default);
        let checkpointer = checkpoint::Checkpointer::start(path, flag("checkpoint", true), flag("shared", false));
        Ok(Self { core: Some(core), checkpointer: Some(checkpointer) })
    }

    fn c(&mut self) -> Result<&mut Core> {
        self.core.as_mut().ok_or_else(|| bad("the database is closed"))
    }

    /// Makes the tables, their indexes and their search tables what `spec` says (JSON: { tables: [...] }, see schema.rs), and remembers it.
    #[napi]
    pub fn migrate(&mut self, spec: String) -> Result<()> {
        #[derive(serde::Deserialize)]
        struct Spec {
            tables: Vec<schema::TableSpec>,
        }
        let s: Spec = serde_json::from_str(&spec).map_err(bad)?;
        self.c()?.migrate(s.tables).map_err(fail)
    }

    /// A read transaction on a reader; -1 when every reader is in use.
    #[napi]
    pub fn begin_read(&mut self, cached: bool) -> Result<i32> {
        Ok(self.c()?.begin_read(cached).map(|i| i as i32).unwrap_or(-1))
    }

    /// The state of one function's writes inside the writer's transaction.
    #[napi]
    pub fn begin_write(&mut self) -> Result<u32> {
        Ok(self.c()?.begin_write() as u32)
    }

    /// A statement of the writer's transaction control: BEGIN IMMEDIATE, SAVEPOINT g, RELEASE g, ROLLBACK TO g, COMMIT, ROLLBACK.
    #[napi]
    pub fn writer_sql(&mut self, sql: String) -> Result<()> {
        self.c()?.writer_sql(&sql).map_err(fail)
    }

    /// `BEGIN IMMEDIATE` without waiting for the write lock: false when another process has it.
    #[napi]
    pub fn writer_begin(&mut self) -> Result<bool> {
        self.c()?.writer_begin().map_err(fail)
    }

    #[napi]
    pub fn writer_in_transaction(&mut self) -> Result<bool> {
        Ok(self.c()?.writer_in_transaction())
    }

    /// Ends a transaction (committing a reader's snapshot, or settling the cache for a writer's tables); what it read and wrote as one string,
    /// `reads` and `writes` apart by \u{1}, their topics apart by \u{0} (a topic is JSON, which has neither character), or an empty string when it did neither.
    #[napi]
    pub fn end_tx(&mut self, tx: u32, ok: bool) -> Result<String> {
        let e = self.c()?.end_tx(tx as usize, ok).map_err(fail)?;
        if e.reads.is_empty() && e.writes.is_empty() {
            return Ok(String::new());
        }
        let mut out = e.reads.join("\u{0}");
        if !e.writes.is_empty() {
            out.push('\u{1}');
            out.push_str(&e.writes.join("\u{0}"));
        }
        Ok(out)
    }

    #[napi]
    pub fn all(&mut self, tx: u32, sql: String, params: Vec<Param>) -> Result<String> {
        self.c()?.all(tx as usize, &sql, bind(params)).map_err(fail)
    }

    #[napi]
    pub fn run(&mut self, tx: u32, sql: String, params: Vec<Param>) -> Result<f64> {
        Ok(self.c()?.run(tx as usize, &sql, bind(params)).map_err(fail)? as f64)
    }

    /// Rows of a statement of JavaScript's own, through the cache: `topics` (JSON array) is what it reads, `table` what the cache keys it under.
    #[napi]
    pub fn select(&mut self, tx: u32, table: String, sql: String, params: Vec<Param>, topics: String) -> Result<String> {
        let topics: Vec<String> = serde_json::from_str(&topics).map_err(bad)?;
        let key = serde_json::to_string(&params.iter().map(|p| match p { Either4::A(s) => Value::from(s.clone()), Either4::B(f) => Value::from(*f), Either4::C(b) => Value::from(*b), Either4::D(_) => Value::Null }).collect::<Vec<_>>()).map_err(bad)?;
        let text = self.c()?.select(tx as usize, &table, &sql, bind(params), &topics, &key).map_err(fail)?;
        Ok(text.to_string())
    }

    /// One document as JSON text, or null.
    #[napi]
    pub fn get(&mut self, tx: u32, id: String) -> Result<Option<String>> {
        self.c()?.get(tx as usize, &id).map_err(fail)
    }

    /// Documents by id, in order, as a JSON array with null where one isn't there.
    #[napi]
    pub fn get_many(&mut self, tx: u32, ids: Vec<String>) -> Result<String> {
        self.c()?.get_many(tx as usize, &ids).map_err(fail)
    }

    /// The documents of a range of `table` (a description as JSON, see plan.rs), as a JSON array. The description is also what a cached answer is found by.
    #[napi]
    pub fn query(&mut self, tx: u32, table: String, desc: String) -> Result<String> {
        Ok(self.c()?.query(tx as usize, &table, &desc).map_err(fail)?.to_string())
    }

    /// A range with its related documents added and its fields chosen (the description carries `includes` and `projection`), as a JSON array.
    #[napi]
    pub fn query_full(&mut self, tx: u32, table: String, desc: String) -> Result<String> {
        self.c()?.query_full(tx as usize, &table, &desc).map_err(fail)
    }

    /// Related documents added to documents JavaScript has (JSON array, and the rules as JSON).
    #[napi]
    pub fn join(&mut self, tx: u32, table: String, docs: String, rules: String) -> Result<String> {
        self.c()?.join(tx as usize, &table, &docs, &rules).map_err(fail)
    }

    /// One page of a range after a cursor, as JSON: { page, isDone, continueCursor, total? }.
    #[napi]
    pub fn paginate(&mut self, tx: u32, table: String, desc: String, num_items: u32, cursor: Option<String>, extra: u32, with_total: bool) -> Result<String> {
        self.c()?.paginate(tx as usize, &table, &desc, num_items as u64, cursor.as_deref(), extra as u64, with_total).map_err(fail)
    }

    /// `sum`, `avg`, `min` or `max` of a number field over a range, as JSON (a number, or null).
    #[napi]
    pub fn aggregate(&mut self, tx: u32, table: String, desc: String, kind: String, field: String) -> Result<String> {
        self.c()?.aggregate(tx as usize, &table, &desc, &kind, &field).map_err(fail)
    }

    /// Search results, best match first, as a JSON array (the description as JSON, see engine/ops.rs).
    #[napi]
    pub fn search(&mut self, tx: u32, spec: String) -> Result<String> {
        self.c()?.search(tx as usize, &spec).map_err(fail)
    }

    #[napi]
    pub fn count(&mut self, tx: u32, table: String, desc: String) -> Result<f64> {
        self.c()?.count(tx as usize, &table, &desc).map_err(fail)
    }

    /// The statement a range reads with, and its parameters (JSON: { sql, params }).
    #[napi]
    pub fn plan_sql(&mut self, desc: String) -> Result<String> {
        let d: plan::Desc = serde_json::from_str(&desc).map_err(bad)?;
        let (sql, params) = self.c()?.plan_sql(&d).map_err(fail)?;
        let params: Vec<Value> = params
            .into_iter()
            .map(|p| match p {
                Sql::Null => Value::Null,
                Sql::Integer(i) => Value::from(i),
                Sql::Real(f) => Value::from(f),
                Sql::Text(t) => Value::from(t),
                Sql::Blob(_) => Value::Null,
            })
            .collect();
        Ok(serde_json::json!({ "sql": sql, "params": params }).to_string())
    }

    /// Inserts documents (each the JSON text of the user's value): validated against the schema, given ids and times, written, indexed for search, with their topics kept.
    /// `trusted` when JavaScript has validated them already. The new ids.
    #[napi]
    pub fn insert(&mut self, tx: u32, table: String, docs: Vec<String>, max_bytes: u32, trusted: bool) -> Result<Vec<String>> {
        self.c()?.insert(tx as usize, &table, &docs, max_bytes as usize, trusted).map_err(fail)
    }

    /// The stored fields of a document as JSON text, from the database (what a write reads before it changes the document), or null.
    /// `insert` for one document: its id (no lists to make on either side of the call).
    #[napi]
    pub fn insert_one(&mut self, tx: u32, table: String, doc: String, max_bytes: u32, trusted: bool) -> Result<String> {
        let mut ids = self.c()?.insert(tx as usize, &table, std::slice::from_ref(&doc), max_bytes as usize, trusted).map_err(fail)?;
        Ok(ids.remove(0))
    }

    #[napi]
    pub fn get_raw(&mut self, tx: u32, id: String) -> Result<Option<String>> {
        self.c()?.get_raw(tx as usize, &id).map_err(fail)
    }

    /// Changes a document in one call: `value` is the new fields (`patch` false) or the changes (`patch` true; a field set to `{"$undefined":true}` is removed); the result is
    /// validated, written and its topics kept. False when it is stored as it is already.
    #[napi]
    pub fn change(&mut self, tx: u32, id: String, value: String, patch: bool, max_bytes: u32, trusted: bool) -> Result<bool> {
        self.c()?.change(tx as usize, &id, &value, patch, max_bytes as usize, trusted).map_err(fail)
    }

    /// Replaces a document's fields (JSON text, validated and merged by JavaScript); false when they are stored as they are. `old` is the text `get_raw` gave, if the caller has it.
    #[napi]
    pub fn replace(&mut self, tx: u32, id: String, json: String, old: Option<String>) -> Result<bool> {
        self.c()?.replace(tx as usize, &id, &json, old.as_deref()).map_err(fail)
    }

    #[napi]
    pub fn delete(&mut self, tx: u32, id: String) -> Result<()> {
        self.c()?.delete(tx as usize, &id).map_err(fail)
    }

    /// A write JavaScript made with statements of its own (a restore): the topics and the cache's bookkeeping of a write of the engine's.
    #[napi]
    pub fn note_written(&mut self, tx: u32, table: String, doc: String, before: Option<String>) -> Result<()> {
        let d: Value = serde_json::from_str(&doc).map_err(bad)?;
        let b: Option<Value> = before.map(|b| serde_json::from_str(&b)).transpose().map_err(bad)?;
        self.c()?.note_written(tx as usize, &table, &d, b.as_ref()).map_err(fail)
    }

    #[napi]
    pub fn set_cache(&mut self, on: bool) -> Result<()> {
        self.c()?.set_cache(on);
        Ok(())
    }

    /// How many reads the cache answered and how many reached the database (JSON: { hits, misses }).
    #[napi]
    pub fn cache_stats(&mut self) -> Result<String> {
        let c = self.c()?;
        Ok(serde_json::json!({ "hits": c.hits, "misses": c.misses }).to_string())
    }

    #[napi]
    pub fn clear_cache(&mut self) -> Result<()> {
        self.c()?.clear_cache();
        Ok(())
    }

    /// Whether writers should hold their next batch (a RESTART checkpoint is waiting for the write lock or running).
    #[napi]
    pub fn paused(&self) -> bool {
        self.checkpointer.as_ref().map(|c| c.paused()).unwrap_or(false)
    }

    /// Stops the checkpoint thread and closes every connection.
    #[napi]
    pub fn close(&mut self) {
        if let Some(mut c) = self.checkpointer.take() {
            c.stop();
        }
        self.core = None;
    }
}
