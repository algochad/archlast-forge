// The benchmark's API with the items in SQLite (rusqlite, bundled): a file on tmpfs in WAL mode, one writer connection behind a mutex and four reader connections,
// the schema and the cap trigger the other servers use. The queries are short, so the handlers call SQLite directly.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const CAP: i64 = 100_000;
const READERS: usize = 4;

#[derive(Serialize)]
struct Item {
    id: i64,
    name: String,
    quantity: i64,
}

struct Db {
    writer: Mutex<Connection>,
    readers: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

type Shared = Arc<Db>;

impl Db {
    fn read<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        let n = self.next.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        f(&self.readers[n].lock().unwrap())
    }
    fn write<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        f(&self.writer.lock().unwrap())
    }
}

fn open(path: &str) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000").unwrap();
    conn
}

#[derive(Deserialize)]
struct Input {
    name: Option<String>,
    quantity: Option<f64>,
}

fn parse(body: &Bytes) -> Option<(String, i64)> {
    let input: Input = serde_json::from_slice(body).ok()?;
    let (name, q) = (input.name?, input.quantity?);
    if name.is_empty() || name.len() > 100 || q < 0.0 || q.fract() != 0.0 {
        return None;
    }
    Some((name, q as i64))
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}
fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "not found")
}
fn invalid() -> Response {
    error(StatusCode::BAD_REQUEST, "invalid item")
}

fn id_of(raw: &str) -> Option<i64> {
    if raw.is_empty() || raw.len() > 15 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<i64>().ok().filter(|n| *n >= 1)
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<String>,
}

async fn list(State(s): State<Shared>, Query(q): Query<ListQuery>) -> Response {
    let limit = q.limit.and_then(|l| l.parse::<i64>().ok()).filter(|n| (1..=100).contains(n)).unwrap_or(20);
    let out: Vec<Item> = s.read(|c| {
        let mut stmt = c.prepare_cached("SELECT id, name, quantity FROM items WHERE id BETWEEN 1 AND ?1 ORDER BY id").unwrap();
        let rows = stmt.query_map(params![limit], |r| Ok(Item { id: r.get(0)?, name: r.get(1)?, quantity: r.get(2)? })).unwrap();
        rows.map(|r| r.unwrap()).collect()
    });
    Json(out).into_response()
}

async fn create(State(s): State<Shared>, body: Bytes) -> Response {
    let Some((name, quantity)) = parse(&body) else { return invalid() };
    let id = s.write(|c| {
        c.prepare_cached("INSERT INTO items (name, quantity) VALUES (?1, ?2)").unwrap().execute(params![name, quantity]).unwrap();
        c.last_insert_rowid()
    });
    (StatusCode::CREATED, Json(Item { id, name, quantity })).into_response()
}

async fn read(State(s): State<Shared>, Path(raw): Path<String>) -> Response {
    let Some(id) = id_of(&raw) else { return not_found() };
    let item = s.read(|c| {
        c.prepare_cached("SELECT id, name, quantity FROM items WHERE id = ?1")
            .unwrap()
            .query_row(params![id], |r| Ok(Item { id: r.get(0)?, name: r.get(1)?, quantity: r.get(2)? }))
            .optional()
            .unwrap()
    });
    match item {
        Some(item) => Json(item).into_response(),
        None => not_found(),
    }
}

async fn update(State(s): State<Shared>, Path(raw): Path<String>, body: Bytes) -> Response {
    let Some(id) = id_of(&raw) else { return not_found() };
    let Some((name, quantity)) = parse(&body) else { return invalid() };
    let changed = s.write(|c| c.prepare_cached("UPDATE items SET name = ?1, quantity = ?2 WHERE id = ?3").unwrap().execute(params![name, quantity, id]).unwrap());
    if changed == 0 {
        return not_found();
    }
    Json(Item { id, name, quantity }).into_response()
}

async fn delete(State(s): State<Shared>, Path(raw): Path<String>) -> Response {
    let Some(id) = id_of(&raw) else { return not_found() };
    let changed = s.write(|c| c.prepare_cached("DELETE FROM items WHERE id = ?1").unwrap().execute(params![id]).unwrap());
    if changed > 0 { StatusCode::NO_CONTENT.into_response() } else { not_found() }
}

#[tokio::main]
async fn main() {
    let path = std::env::var("DB_PATH").unwrap_or_else(|_| "/data/bench.db".into());
    let writer = open(&path);
    writer
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity INTEGER NOT NULL);
             CREATE TRIGGER IF NOT EXISTS items_cap AFTER INSERT ON items BEGIN DELETE FROM items WHERE id = NEW.id - {CAP}; END"
        ))
        .unwrap();
    let seeded: Option<i64> = writer.query_row("SELECT 1 FROM items LIMIT 1", [], |r| r.get(0)).optional().unwrap();
    if seeded.is_none() {
        let tx = writer.unchecked_transaction().unwrap();
        for id in 1..=1000i64 {
            tx.execute("INSERT INTO items (id, name, quantity) VALUES (?1, ?2, ?3)", params![id, format!("item-{id}"), id % 100]).unwrap();
        }
        tx.commit().unwrap();
    }
    let readers = (0..READERS).map(|_| Mutex::new(open(&path))).collect();
    let state: Shared = Arc::new(Db { writer: Mutex::new(writer), readers, next: AtomicUsize::new(0) });
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/items", get(list).post(create))
        .route("/items/{id}", get(read).put(update).delete(delete))
        .fallback(|| async { not_found() })
        .with_state(state);
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
