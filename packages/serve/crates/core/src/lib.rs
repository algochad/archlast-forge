//! Transport-agnostic core: an axum/hyper/tokio HTTP + WebSocket server whose dynamic work is handed to
//! one or more JS threads ("lanes"). Each lane pulls events with `drain` and pushes commands with `command`.
//! Static routes are answered entirely on the Rust side. Wire formats are documented in `src/codec.ts`.

mod file;
mod pagecache;
pub mod json;
pub mod template;
pub use template::{register as template_register, render as template_render};
mod http;
#[cfg(feature = "profile")]
mod profile;
mod state;
mod deflate;
mod tls;
mod uws;
mod wsconn;
mod tpc;
mod wire;

use axum::{body::Bytes, http::StatusCode};
use state::{Shared, StaticResponse};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};
use wire::{parse_headers, skip_headers, Reader};

pub use state::Notify;

pub struct Server {
    tpc: Mutex<Option<tpc::Tpc>>,
    shared: Arc<Shared>,
    port: u16,
}

static SERVERS: Mutex<Option<HashMap<u32, Arc<Server>>>> = Mutex::new(None);
static NEXT_SERVER: AtomicU32 = AtomicU32::new(1);

fn lookup(id: u32) -> Result<Arc<Server>, String> {
    SERVERS.lock().unwrap().as_ref().and_then(|m| m.get(&id).cloned()).ok_or_else(|| format!("no server {id}"))
}

/// `opts` layout: `u16 port, u32 threads(0=all), u32 max_body, u16 host_len, host,
/// u32 static_count, static_count * (u8 method_len, method, u16 path_len, path, u16 status, u16 header_count,
/// headers..., u32 body_len, body), u16 ws_route_count, ws_route_count * (u8 kind (0 exact, 1 prefix, 2 any), u16 len,
/// path), u16 idle_timeout_s, u16 ws_idle_timeout_s, u32 ws_max_message, u32 ws_backpressure, u16 ws_ping_s,
/// u8 ws_close_on_backpressure, u8 flags (bit0 reuse_port, bit1 ipv6_only), u16 unix_len, unix path,
/// u8 tls_count, tls_count * (u32 len + cert PEM, u32 len + key PEM, u32 len + server name, u32 len + CA PEM, u8 flags
/// (bit0 request_cert, bit1 reject_unauthorized, bit2 no TLS 1.2, bit3 no TLS 1.3)), u8 deflate flags (bit0 enabled, bit1 compress, bit2 no context takeover),
/// u8 deflate window bits, u16 spin microseconds, u8 spin connection limit`.
/// Returns `(server id, bound port)`.
pub fn start(opts: &[u8], lanes: usize) -> Result<(u32, u16), String> {
    #[cfg(feature = "profile")]
    profile::maybe_start();
    let mut r = Reader::new(opts);
    let port = r.u16()?;
    let threads = r.u32()? as usize;
    let max_body = r.u32()? as usize;
    let hlen = r.u16()? as usize;
    let host = r.str(hlen)?.to_string();

    let mut statics: HashMap<String, HashMap<String, Arc<StaticResponse>>> = HashMap::new();
    for _ in 0..r.u32()? {
        let ml = r.u8()? as usize;
        let method = r.str(ml)?.to_string();
        let pl = r.u16()? as usize;
        let path = r.str(pl)?.to_string();
        let status = StatusCode::from_u16(r.u16()?).map_err(|e| e.to_string())?;
        let hc = r.u16()?;
        let raw = skip_headers(&mut r, hc)?;
        let mut headers = axum::http::HeaderMap::new();
        parse_headers(raw, hc, &mut headers);
        let bl = r.u32()? as usize;
        let body = Bytes::copy_from_slice(r.take(bl)?);
        statics.entry(method).or_default().insert(path, Arc::new(StaticResponse { etag: if status == StatusCode::OK { headers.get(axum::http::header::ETAG).cloned() } else { None }, status, headers, body }));
    }
    let (mut exact, mut prefixes, mut any) = (HashSet::new(), Vec::new(), false);
    for _ in 0..r.u16()? {
        let kind = r.u8()?;
        let n = r.u16()? as usize;
        let path = r.str(n)?.to_string();
        match kind {
            0 => {
                exact.insert(path);
            }
            1 => prefixes.push(path),
            _ => any = true,
        }
    }
    let idle = r.u16()? as u32;
    let ws_idle = r.u16()? as u32;
    let mut ws = state::WsConfig {
        exact,
        prefixes,
        any,
        max_message: r.u32()? as usize,
        backpressure: r.u32()? as usize,
        ping_secs: r.u16()? as u32,
        close_on_backpressure: r.u8()? != 0,
        deflate: None,
    };
    let flags = r.u8()?;
    let (reuse_port, ipv6_only) = (flags & 1 != 0 || std::env::var("ARCHLAST_REUSEPORT").as_deref() == Ok("1"), flags & 2 != 0);
    let ul = r.u16()? as usize;
    let unix = if ul > 0 { Some(r.str(ul)?.to_string()) } else { None };
    let mut tls_entries = Vec::new();
    for _ in 0..r.u8()? {
        let text = |r: &mut Reader| -> Result<String, String> {
            let n = r.u32()? as usize;
            Ok(r.str(n)?.to_string())
        };
        let (cert, key, server_name, ca) = (text(&mut r)?, text(&mut r)?, text(&mut r)?, text(&mut r)?);
        let f = r.u8()?;
        tls_entries.push(tls::TlsEntry { cert, key, server_name, ca, request_cert: f & 1 != 0, reject_unauthorized: f & 2 != 0, no_tls12: f & 4 != 0, no_tls13: f & 8 != 0 });
    }
    let d = r.u8()?;
    let bits = r.u8()?;
    let spin_us = r.u16()? as u64;
    let spin_max_conns = r.u8()? as usize;
    if d & 1 != 0 {
        ws.deflate = Some(deflate::Config { compress: d & 2 != 0, no_context_takeover: d & 4 != 0, window_bits: bits });
    }
    let tls = if tls_entries.is_empty() { None } else { Some(tls::build(&tls_entries, flags & 4 == 0)?) };
    let shared = Arc::new(Shared::new(lanes, statics, max_body, ws, idle, ws_idle, tls, spin_us, spin_max_conns));

    // Thread-per-core: one single-threaded runtime per I/O thread, connections never change thread.
    let n = if threads > 0 { threads } else { std::thread::available_parallelism().map_or(1, |n| n.get()) };
    let listen = match &unix {
        Some(path) => tpc::Listen::Unix(path.clone()),
        None => tpc::Listen::Tcp { host: host.clone(), port, reuse_port, ipv6_only },
    };
    let (tpc, bound) = tpc::start(shared.clone(), listen, n)?;

    let id = NEXT_SERVER.fetch_add(1, Ordering::Relaxed);
    let server = Arc::new(Server { tpc: Mutex::new(Some(tpc)), shared, port: bound });
    SERVERS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, server);
    Ok((id, bound))
}

pub fn port(id: u32) -> Result<u16, String> {
    Ok(lookup(id)?.port)
}

/// Stops the server; lane handles stay valid but go quiet.
pub fn stop(id: u32) {
    let server = SERVERS.lock().unwrap().as_mut().and_then(|m| m.remove(&id));
    if let Some(s) = server {
        s.shared.stopping.store(true, Ordering::Relaxed);
        for lane in 0..s.shared.lanes.len() {
            s.shared.detach(lane);
        }
        s.shared.clear_queues();
        if let Some(t) = s.tpc.lock().unwrap().take() {
            t.stop();
        }
    }
}

/// Begins a graceful shutdown: stop accepting, let requests in flight finish, close idle connections, close
/// WebSockets with 1012. Non-blocking; poll `open_connections` until it reaches 0, then call `stop`.
pub fn drain_begin(id: u32) -> Result<bool, String> {
    let s = lookup(id)?;
    s.shared.close_all_ws(1012, "service restart");
    s.shared.stopping.store(true, Ordering::Relaxed);
    let guard = s.tpc.lock().unwrap();
    let can_drain = match guard.as_ref() {
        Some(t) => {
            t.drain();
            true
        }
        None => false,
    };
    drop(guard);
    Ok(can_drain)
}

/// `[pending requests, open WebSockets, open connections]`.
pub fn stats(id: u32) -> Result<[u64; 3], String> {
    let s = lookup(id)?;
    Ok([s.shared.pending_requests.load(Ordering::Relaxed) as u64, s.shared.ws_count() as u64, s.shared.open_conns.load(Ordering::Relaxed) as u64])
}

pub fn topic_count(id: u32, topic: &str) -> Result<usize, String> {
    Ok(lookup(id)?.shared.topic_count(topic))
}

/// Bytes queued for a WebSocket, or -1 if it is gone.
pub fn ws_buffered(id: u32, ws: u32) -> Result<i64, String> {
    Ok(lookup(id)?.shared.ws_buffered(ws))
}

/// Closes keep-alive connections that have no request in flight; returns how many.
pub fn close_idle(id: u32) -> Result<usize, String> {
    Ok(lookup(id)?.shared.close_idle())
}

pub fn open_connections(id: u32) -> Result<usize, String> {
    Ok(lookup(id)?.shared.open_conns.load(Ordering::Relaxed))
}

/// Marks a lane dead (e.g. its worker crashed) so no new work is routed to it.
pub fn detach_lane(id: u32, lane: usize) -> Result<(), String> {
    let s = lookup(id)?;
    if lane >= s.shared.lanes.len() {
        return Err(format!("no lane {lane}"));
    }
    s.shared.detach(lane);
    Ok(())
}

/// One JS thread's view of a server. Cheap to clone; all calls must come from that thread.
pub struct LaneHandle {
    shared: Arc<Shared>,
    lane: usize,
}

/// Connects a JS thread to lane `lane`. `notify` fires (coalesced) when the lane has work.
pub fn attach(id: u32, lane: usize, notify: Notify) -> Result<LaneHandle, String> {
    let s = lookup(id)?;
    if lane >= s.shared.lanes.len() {
        return Err(format!("no lane {lane}"));
    }
    s.shared.attach(lane, notify);
    Ok(LaneHandle { shared: s.shared.clone(), lane })
}

impl LaneHandle {
    pub fn drain(&self, out: &mut [u8]) -> i32 {
        self.shared.drain(self.lane, out)
    }
    /// Returns true if work arrived while parking (keep draining); false once the lane is asleep.
    pub fn park(&self) -> bool {
        self.shared.park(self.lane)
    }
    pub fn command(&self, data: &[u8]) -> Result<(), String> {
        self.shared.command(self.lane, data)
    }
    /// Releases the notify callback (and whatever it keeps alive on the JS side).
    pub fn detach(&self) {
        self.shared.detach(self.lane);
    }
}
