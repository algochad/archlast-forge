use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};

const CAP: i64 = 100_000;

#[derive(Clone, Serialize)]
struct Item {
    id: i64,
    name: String,
    quantity: i64,
}

struct Store {
    items: HashMap<i64, Item>,
    next_id: i64,
}

type Shared = Arc<RwLock<Store>>;

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
    let store = s.read().unwrap();
    let out: Vec<Item> = (1..=limit).filter_map(|id| store.items.get(&id).cloned()).collect();
    Json(out).into_response()
}

async fn create(State(s): State<Shared>, body: Bytes) -> Response {
    let Some((name, quantity)) = parse(&body) else { return invalid() };
    let mut store = s.write().unwrap();
    let item = Item { id: store.next_id, name, quantity };
    store.next_id += 1;
    store.items.insert(item.id, item.clone());
    store.items.remove(&(item.id - CAP));
    (StatusCode::CREATED, Json(item)).into_response()
}

async fn read(State(s): State<Shared>, Path(raw): Path<String>) -> Response {
    let Some(id) = id_of(&raw) else { return not_found() };
    match s.read().unwrap().items.get(&id) {
        Some(item) => Json(item.clone()).into_response(),
        None => not_found(),
    }
}

async fn update(State(s): State<Shared>, Path(raw): Path<String>, body: Bytes) -> Response {
    let Some(id) = id_of(&raw) else { return not_found() };
    let Some((name, quantity)) = parse(&body) else { return invalid() };
    let mut store = s.write().unwrap();
    if !store.items.contains_key(&id) {
        return not_found();
    }
    let item = Item { id, name, quantity };
    store.items.insert(id, item.clone());
    Json(item).into_response()
}

async fn delete(State(s): State<Shared>, Path(raw): Path<String>) -> Response {
    let Some(id) = id_of(&raw) else { return not_found() };
    if s.write().unwrap().items.remove(&id).is_some() { StatusCode::NO_CONTENT.into_response() } else { not_found() }
}

#[tokio::main]
async fn main() {
    let mut items = HashMap::new();
    for id in 1..=1000 {
        items.insert(id, Item { id, name: format!("item-{id}"), quantity: id % 100 });
    }
    let state: Shared = Arc::new(RwLock::new(Store { items, next_id: 1001 }));
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
