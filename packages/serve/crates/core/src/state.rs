//! Shared server state: per-lane queues, in-flight response slots, WebSocket registry and pub/sub topics.
use crate::wire::{skip_headers, Reader};
use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode},
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use crate::tpc::ConnState;
use tokio::sync::{mpsc, oneshot, Notify as TokioNotify};

pub type Notify = Arc<dyn Fn() + Send + Sync>;

/// A complete response as produced by JS; headers stay raw until the tokio thread builds the HTTP response.
pub struct Full {
    pub status: u16,
    /// Content-type code: 0 none (or in `headers`), 1 text, 2 JSON, 3 binary. Saves parsing a header per response.
    pub ct: u8,
    pub headers: Vec<u8>,
    pub header_count: u16,
    pub body: Vec<u8>,
}

/// A file for Rust to stream: it owns Range/HEAD/ETag handling, so JS never touches the bytes.
pub struct FileReply {
    pub status: u16,
    /// Honour `Range` requests.
    pub range: bool,
    pub headers: Vec<u8>,
    pub header_count: u16,
    pub path: String,
    /// Explicit content type; empty means "derive from the extension".
    pub content_type: String,
}

pub enum Reply {
    File(FileReply),
    /// JS accepted a WebSocket upgrade: extra response headers and the subprotocol to echo (empty: none).
    Upgrade { headers: Vec<u8>, header_count: u16, protocol: String },
    Full(Full),
    Stream { lane: usize, id: u32, status: u16, headers: Vec<u8>, header_count: u16, rx: mpsc::UnboundedReceiver<StreamMsg> },
}

pub struct StaticResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
    /// The entity tag of a 200 response, when it carries one: a matching `If-None-Match` gets a 304 without a body.
    pub etag: Option<axum::http::HeaderValue>,
}

/// Flow control of a request body that is streamed to JS: Rust may send `credit` more bytes; JS refills it as its
/// stream is consumed, so a slow handler holds the client back instead of filling memory.
pub struct BodyFlow {
    pub credit: AtomicI64,
    pub wake: TokioNotify,
    pub cancelled: AtomicBool,
}

/// Shared between a request's HTTP task and the lane that takes it.
pub struct ReqCell {
    /// `((lane + 1) << 32) | id`, set when a lane takes the request (0 until then).
    pub v: AtomicU64,
    pub taken: TokioNotify,
    pub body: Option<Arc<BodyFlow>>,
}

pub enum QItem {
    /// Request chunk without kind/id (those are written at drain time). Pooled: any awake lane may take it.
    /// `io` is the I/O thread that owns the connection.
    Request { chunk: Vec<u8>, tx: oneshot::Sender<Reply>, io: usize, cell: Arc<ReqCell>, conn: Option<Arc<ConnState>> },
    /// Fully serialized event (kind byte included). Bound to the lane that owns the connection.
    Event(Vec<u8>),
    /// Several serialized events back to back (`count` of them): one allocation and one copy for a whole read's messages.
    Events { bytes: Vec<u8>, count: u32 },
    /// The client of a streaming response went away. Lane-bound.
    Closed(u32),
    /// The client of a request that JS already took went away (fires `req.signal`). Lane-bound.
    Aborted(u32),
}

fn item_size(it: &QItem) -> usize {
    match it {
        QItem::Request { chunk, .. } => 1 + 4 + chunk.len(),
        QItem::Event(e) => e.len(),
        QItem::Events { bytes, .. } => bytes.len(),
        QItem::Closed(_) | QItem::Aborted(_) => 5,
    }
}

/// Scheduling state of the JS thread pool. Requests wait in one shared queue; lanes are woken only when needed.
struct Sched {
    global: VecDeque<QItem>,
    /// Sleeping lanes; the most recently parked is woken first, so a few hot threads do the work.
    parked: Vec<usize>,
    awake: Vec<bool>,
    awake_count: usize,
    /// Wake another lane when more than `backlog` requests wait per awake lane.
    backlog: usize,
}

impl Sched {
    /// Picks a sleeping lane to wake for newly queued work, if any is needed.
    fn wake_for_requests(&mut self) -> Option<usize> {
        if self.parked.is_empty() {
            return None;
        }
        if self.awake_count == 0 || self.global.len() > self.awake_count * self.backlog {
            let l = self.parked.pop()?;
            self.awake[l] = true;
            self.awake_count += 1;
            return Some(l);
        }
        None
    }

    /// Wakes `lane` for a lane-bound event if it is asleep.
    fn wake_lane(&mut self, lane: usize) -> bool {
        if self.awake[lane] || !self.parked.contains(&lane) {
            return false;
        }
        self.parked.retain(|l| *l != lane);
        self.awake[lane] = true;
        self.awake_count += 1;
        true
    }
}

enum Slot {
    /// The request's sender and the I/O thread that owns its connection (`usize::MAX`: no I/O inbox).
    Response(oneshot::Sender<Reply>, usize, Option<Arc<ConnState>>),
    Stream(mpsc::UnboundedSender<StreamMsg>),
}

/// What JS sends into a streaming response body.
pub enum StreamMsg {
    Chunk(Bytes),
    /// The producer failed: abort the connection instead of ending the body cleanly.
    Abort,
}

/// Ids are sequential u32s, so hashing them is wasted work: the id is its own hash.
#[derive(Default)]
pub struct IdHasher(u64);
impl std::hash::Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 << 8) | *b as u64;
        }
    }
    fn write_u32(&mut self, n: u32) {
        self.0 = n as u64;
    }
}
type IdMap<V> = HashMap<u32, V, std::hash::BuildHasherDefault<IdHasher>>;

/// Responses for one I/O thread, delivered in bulk: one cross-thread wake per command batch instead of one per
/// response. The thread's own task then completes each request locally (no further cross-thread wake-ups).
#[derive(Default)]
pub struct IoInbox {
    /// Items queued for this thread (cheap to check without the locks): the spinner polls it.
    pub pending: AtomicUsize,
    /// Wakes the spinner task after this thread handed work to JS.
    pub spin: tokio::sync::Notify,
    pub q: Mutex<Vec<(oneshot::Sender<Reply>, Reply)>>,
    /// WebSocket output queued by JS for sockets this thread owns; handed to each socket's writer locally.
    pub ws: Mutex<Vec<(mpsc::UnboundedSender<WsOut>, WsOut)>>,
    pub notify: tokio::sync::Notify,
}

/// A WebSocket message queued for a socket. Payloads are shared (`Bytes`), so a publish to many sockets copies nothing.
#[derive(Clone)]
pub enum WsMsg {
    Text(Bytes),
    Binary(Bytes),
    Ping(Bytes),
    Pong(Bytes),
}

pub enum WsOut {
    Msg(WsMsg),
    /// JS asked to close: send a Close frame, then give the peer a moment to answer.
    Close(u16, String),
}

/// Lets JS pause and resume reading from one socket (receive-side flow control).
pub struct PauseGate {
    pub paused: AtomicBool,
    pub wake: TokioNotify,
}

/// Output for sockets, gathered per I/O thread while a command batch is processed, then handed over with one wake each.
type WsBatch = Vec<Vec<(mpsc::UnboundedSender<WsOut>, WsOut)>>;

struct WsConn {
    tx: mpsc::UnboundedSender<WsOut>,
    /// The I/O thread that owns the socket.
    io: usize,
    lane: usize,
    topics: Vec<String>,
    /// Bytes queued for this socket that the kernel has not accepted yet; over the limit the socket is dropped.
    pending: Arc<AtomicUsize>,
    kill: Option<oneshot::Sender<()>>,
    gate: Arc<PauseGate>,
    /// Set while the backlog is over the limit in the non-closing mode, so a drain event can follow.
    over: Arc<AtomicBool>,
}

/// WebSocket limits and routing, from the options blob.
pub struct WsConfig {
    pub exact: HashSet<String>,
    pub prefixes: Vec<String>,
    /// Every upgrade request is offered to JS (the Bun.serve-style facade).
    pub any: bool,
    pub max_message: usize,
    pub backpressure: usize,
    pub ping_secs: u32,
    /// Drop a client whose backlog passes the limit (otherwise sends keep queueing and `drain` fires later).
    pub close_on_backpressure: bool,
    /// permessage-deflate settings, when the extension is enabled.
    pub deflate: Option<crate::deflate::Config>,
}

#[derive(Default)]
pub struct Lane {
    /// Events bound to this lane (WebSocket traffic, stream disconnects).
    queue: Mutex<Vec<QItem>>,
    notify: Mutex<Option<Notify>>,
    attached: AtomicBool,
    /// Only touched from this lane's JS thread (drain / command).
    inflight: Mutex<IdMap<Slot>>,
    /// Streamed request bodies of the requests this lane has taken (JS thread only).
    bodies: Mutex<IdMap<Arc<BodyFlow>>>,
}

impl Lane {
    /// Calls the JS notifier while holding its lock: `detach` takes the same lock, so once it returns
    /// no call is in flight and the callback (which may live in a dying worker) is never touched again.
    fn call_notify(&self) {
        let g = self.notify.lock().unwrap();
        if let Some(n) = g.as_ref() {
            n();
        }
    }

}

pub struct Shared {
    pub lanes: Vec<Lane>,
    sched: Mutex<Sched>,
    rr: AtomicUsize,
    pub next_id: AtomicU32,
    pub statics: HashMap<String, HashMap<String, Arc<StaticResponse>>>,
    pub max_body: usize,
    /// Idle timeouts in seconds (0 = none): plain connections and upgraded WebSockets.
    pub idle: u32,
    pub ws_idle: u32,
    /// Live connections, for graceful shutdown.
    pub open_conns: AtomicUsize,
    /// Set for an HTTPS server.
    pub tls: Option<tokio_rustls::TlsAcceptor>,
    /// Requests handed to JS that have not been answered yet.
    pub pending_requests: AtomicUsize,
    /// Every live connection, so idle ones can be closed on demand.
    pub conn_registry: Mutex<Vec<std::sync::Weak<ConnState>>>,
    /// Set when the server is shutting down: requests dropped by it get a 503, not a 500.
    pub stopping: AtomicBool,
    pub ws: WsConfig,
    /// Nanoseconds an I/O thread keeps polling for the answer after handing work to JS (0 = sleep right away).
    pub spin_ns: u64,
    /// Polling only pays while few connections are open: with many, threads are busy anyway and spinning just burns CPU.
    pub spin_max_conns: usize,
    /// Per-I/O-thread response inboxes (thread-per-core engine only).
    pub io: std::sync::OnceLock<Vec<Arc<IoInbox>>>,
    /// Complete responses handlers asked to have kept (see pagecache.rs).
    pub cache: crate::pagecache::PageCache,
    ws_conns: Mutex<IdMap<WsConn>>,
    topics: Mutex<HashMap<String, Vec<u32>>>,
}

impl Shared {
    #[allow(clippy::too_many_arguments)] // the server's whole configuration, from one options blob
    pub fn new(lanes: usize, statics: HashMap<String, HashMap<String, Arc<StaticResponse>>>, max_body: usize, ws: WsConfig, idle: u32, ws_idle: u32, tls: Option<tokio_rustls::TlsAcceptor>, spin_us: u64, spin_max_conns: usize) -> Self {
        let n = lanes.max(1);
        let backlog = std::env::var("ARCHLAST_BACKLOG").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
        Shared {
            lanes: (0..n).map(|_| Lane::default()).collect(),
            sched: Mutex::new(Sched { global: VecDeque::new(), parked: Vec::new(), awake: vec![false; n], awake_count: 0, backlog }),
            rr: AtomicUsize::new(0),
            next_id: AtomicU32::new(1),
            statics,
            max_body,
            idle,
            ws_idle,
            open_conns: AtomicUsize::new(0),
            tls,
            pending_requests: AtomicUsize::new(0),
            conn_registry: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false),
            ws,
            spin_ns: spin_us * 1000,
            spin_max_conns,
            io: std::sync::OnceLock::new(),
            cache: crate::pagecache::PageCache::new(std::env::var("ARCHLAST_PAGE_CACHE_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(64) << 20),
            ws_conns: Mutex::new(IdMap::default()),
            topics: Mutex::new(HashMap::new()),
        }
    }

    pub fn new_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Round-robin over lanes whose JS thread is attached (lane 0 when none is yet).
    pub fn pick_lane(&self) -> usize {
        let n = self.lanes.len();
        if n == 1 {
            return 0;
        }
        let start = self.rr.fetch_add(1, Ordering::Relaxed);
        for k in 0..n {
            let i = (start + k) % n;
            if self.lanes[i].attached.load(Ordering::Acquire) {
                return i;
            }
        }
        0
    }

    /// Queues a stateless request for whichever lane is (or becomes) free.
    /// Queues a request. Ordinary requests join the shared pool (whichever lane is free takes them); a WebSocket
    /// upgrade is dealt round-robin to one lane instead, because that lane will own the socket for its whole life
    /// and a long-lived connection cannot spill over to another thread when its owner gets busy.
    pub fn push_request(&self, chunk: Vec<u8>, tx: oneshot::Sender<Reply>, io: usize, cell: Arc<ReqCell>, conn: Option<Arc<ConnState>>, upgrade: bool) {
        if upgrade {
            let lane = self.pick_lane();
            self.push(lane, QItem::Request { chunk, tx, io, cell, conn });
            return;
        }
        self.kick_spinner();
        let wake = {
            let mut sc = self.sched.lock().unwrap();
            sc.global.push_back(QItem::Request { chunk, tx, io, cell, conn });
            sc.wake_for_requests()
        };
        if let Some(l) = wake {
            self.lanes[l].call_notify();
        }
    }

    /// Queues an event for the lane that owns the connection.
    /// Called from an I/O thread that just handed work to JS: its answer is expected soon, so poll instead of sleeping.
    #[inline]
    fn kick_spinner(&self) {
        if self.spin_ns == 0 || self.open_conns.load(Ordering::Relaxed) > self.spin_max_conns {
            return;
        }
        let io = crate::tpc::io_index();
        if let Some(v) = self.io.get() {
            if io < v.len() {
                v[io].spin.notify_one();
            }
        }
    }

    pub fn push(&self, lane: usize, item: QItem) {
        self.kick_spinner();
        self.lanes[lane].queue.lock().unwrap().push(item);
        let wake = self.sched.lock().unwrap().wake_lane(lane);
        if wake {
            self.lanes[lane].call_notify();
        }
    }

    /// Queues several events for the same lane with one lock round and at most one wake-up.
    pub fn push_events(&self, lane: usize, bytes: &mut Vec<u8>, count: &mut u32) {
        if *count == 0 {
            return;
        }
        self.kick_spinner();
        {
            let mut q = self.lanes[lane].queue.lock().unwrap();
            q.push(QItem::Events { bytes: std::mem::take(bytes), count: std::mem::take(count) });
        }
        let wake = self.sched.lock().unwrap().wake_lane(lane);
        if wake {
            self.lanes[lane].call_notify();
        }
    }

    pub fn attach(&self, lane: usize, notify: Notify) {
        let l = &self.lanes[lane];
        *l.notify.lock().unwrap() = Some(notify);
        l.attached.store(true, Ordering::Release);
        let wake = {
            let mut sc = self.sched.lock().unwrap();
            if !sc.awake[lane] && !sc.parked.contains(&lane) {
                sc.parked.push(lane);
            }
            if !sc.global.is_empty() || !l.queue.lock().unwrap().is_empty() {
                sc.wake_lane(lane)
            } else {
                false
            }
        };
        if wake {
            l.call_notify();
        }
    }

    /// Stops routing to a lane and fails whatever it still holds (its JS thread is gone or leaving).
    /// Pooled requests still waiting in the shared queue are simply taken by the other lanes.
    pub fn detach(&self, lane: usize) {
        let l = &self.lanes[lane];
        l.attached.store(false, Ordering::Release);
        let successor = {
            let mut sc = self.sched.lock().unwrap();
            sc.parked.retain(|x| *x != lane);
            if sc.awake[lane] {
                sc.awake[lane] = false;
                sc.awake_count -= 1;
            }
            // Requests this lane was about to take must not be left without anyone awake to take them.
            if sc.global.is_empty() { None } else { sc.wake_for_requests() }
        };
        *l.notify.lock().unwrap() = None; // barrier: waits for any in-flight notify call
        if let Some(next) = successor {
            self.lanes[next].call_notify();
        }
        let stranded: Vec<QItem> = std::mem::take(&mut *l.queue.lock().unwrap());
        drop(stranded);
        l.inflight.lock().unwrap().clear();
        let conns: Vec<mpsc::UnboundedSender<WsOut>> =
            self.ws_conns.lock().unwrap().values().filter(|c| c.lane == lane).map(|c| c.tx.clone()).collect();
        for tx in conns {
            let _ = tx.send(WsOut::Close(1012, "service restart".into()));
        }
    }

    /// Drops everything still queued (server shutdown).
    pub fn clear_queues(&self) {
        let drained: Vec<QItem> = self.sched.lock().unwrap().global.drain(..).collect();
        drop(drained);
    }

    fn ws_gate(&self, id: u32, paused: bool) {
        if let Some(c) = self.ws_conns.lock().unwrap().get(&id) {
            c.gate.paused.store(paused, Ordering::Release);
            c.gate.wake.notify_one();
        }
    }

    /// Bytes queued for a socket, or -1 if it is gone.
    pub fn ws_buffered(&self, id: u32) -> i64 {
        self.ws_conns.lock().unwrap().get(&id).map_or(-1, |c| c.pending.load(Ordering::Relaxed) as i64)
    }

    pub fn ws_count(&self) -> usize {
        self.ws_conns.lock().unwrap().len()
    }

    pub fn topic_count(&self, topic: &str) -> usize {
        self.topics.lock().unwrap().get(topic).map_or(0, |v| v.len())
    }

    /// Whether an upgrade request for `path` is offered to JS.
    pub fn ws_match(&self, path: &str) -> bool {
        self.ws.any || self.ws.exact.contains(path) || self.ws.prefixes.iter().any(|p| path.starts_with(p.as_str()))
    }

    /// Closes connections with no request in flight (keep-alive leftovers); returns how many.
    pub fn close_idle(&self) -> usize {
        let mut reg = self.conn_registry.lock().unwrap();
        let mut n = 0;
        reg.retain(|w| match w.upgrade() {
            None => false,
            Some(c) => {
                if c.is_idle() {
                    c.close_now();
                    n += 1;
                }
                true
            }
        });
        n
    }

    /// Closes every WebSocket (used when the server shuts down).
    pub fn close_all_ws(&self, code: u16, reason: &str) {
        let conns: Vec<mpsc::UnboundedSender<WsOut>> = self.ws_conns.lock().unwrap().values().map(|c| c.tx.clone()).collect();
        for tx in conns {
            let _ = tx.send(WsOut::Close(code, reason.to_string()));
        }
    }

    // ---------- WebSocket registry ----------

    #[allow(clippy::too_many_arguments)] // a socket's shared handles, registered once
    pub fn ws_register(&self, id: u32, lane: usize, tx: mpsc::UnboundedSender<WsOut>, pending: Arc<AtomicUsize>, kill: oneshot::Sender<()>, gate: Arc<PauseGate>, over: Arc<AtomicBool>) {
        self.ws_conns.lock().unwrap().insert(id, WsConn { tx, io: crate::tpc::io_index(), lane, topics: Vec::new(), pending, kill: Some(kill), gate, over });
    }

    /// Queues `out` for a socket (dropping the socket instead if its backlog is over the backpressure limit); the output joins `batch` (handed to the owning I/O thread after the command batch) instead of
    /// waking that thread's writer task from here, which costs a cross-thread wake per socket.
    fn deliver_batched(&self, c: &mut WsConn, out: WsOut, batch: &mut WsBatch) {
        if let WsOut::Msg(m) = &out {
            let len = match m {
                WsMsg::Text(t) => t.len(),
                WsMsg::Binary(b) => b.len(),
                _ => 0,
            };
            if c.pending.fetch_add(len, Ordering::Relaxed) + len > self.ws.backpressure {
                if self.ws.close_on_backpressure {
                    if let Some(k) = c.kill.take() {
                        let _ = k.send(());
                    }
                    return;
                }
                c.over.store(true, Ordering::Relaxed);
            }
        }
        if c.io == usize::MAX || self.io.get().is_none_or(|v| c.io >= v.len()) {
            let _ = c.tx.send(out);
            return;
        }
        if batch.len() <= c.io {
            batch.resize_with(c.io + 1, Vec::new);
        }
        batch[c.io].push((c.tx.clone(), out));
    }

    fn flush_ws_batch(&self, batch: WsBatch) {
        let Some(inboxes) = self.io.get() else { return };
        for (io, items) in batch.into_iter().enumerate() {
            if items.is_empty() || io >= inboxes.len() {
                continue;
            }
            inboxes[io].pending.fetch_add(items.len(), Ordering::Release);
            inboxes[io].ws.lock().unwrap().extend(items);
            inboxes[io].notify.notify_one();
        }
    }

    pub fn ws_unregister(&self, id: u32) {
        let conn = self.ws_conns.lock().unwrap().remove(&id);
        if let Some(c) = conn {
            let mut topics = self.topics.lock().unwrap();
            for t in c.topics {
                if let Some(v) = topics.get_mut(&t) {
                    v.retain(|x| *x != id);
                    if v.is_empty() {
                        topics.remove(&t);
                    }
                }
            }
        }
    }

    fn ws_send_batched(&self, id: u32, out: WsOut, batch: &mut WsBatch) {
        let mut conns = self.ws_conns.lock().unwrap();
        if let Some(c) = conns.get_mut(&id) {
            self.deliver_batched(c, out, batch);
        }
    }

    /// The same for a run of sends in one command batch: the socket map stays locked between them.
    fn ws_send_held(&self, conns: &mut IdMap<WsConn>, id: u32, out: WsOut, batch: &mut WsBatch) {
        if let Some(c) = conns.get_mut(&id) {
            self.deliver_batched(c, out, batch);
        }
    }

    fn subscribe(&self, id: u32, topic: String) {
        {
            let mut ws = self.ws_conns.lock().unwrap();
            let Some(c) = ws.get_mut(&id) else { return };
            if c.topics.contains(&topic) {
                return;
            }
            c.topics.push(topic.clone());
        }
        self.topics.lock().unwrap().entry(topic).or_default().push(id);
    }

    fn unsubscribe(&self, id: u32, topic: &str) {
        if let Some(c) = self.ws_conns.lock().unwrap().get_mut(&id) {
            c.topics.retain(|t| t != topic);
        }
        let mut topics = self.topics.lock().unwrap();
        if let Some(v) = topics.get_mut(topic) {
            v.retain(|x| *x != id);
            if v.is_empty() {
                topics.remove(topic);
            }
        }
    }

    fn publish(&self, topic: &str, msg: WsMsg, exclude: u32, batch: &mut WsBatch) {
        let ids: Vec<u32> = match self.topics.lock().unwrap().get(topic) {
            Some(v) => v.iter().copied().filter(|i| *i != exclude).collect(),
            None => return,
        };
        let mut conns = self.ws_conns.lock().unwrap();
        for id in ids {
            if let Some(c) = conns.get_mut(&id) {
                self.deliver_batched(c, WsOut::Msg(msg.clone()), batch);
            }
        }
    }

    // ---------- JS thread side ----------

    /// Stops reading a request body that is still streaming (its handler answered or gave up).
    fn finish_body(&self, l: &Lane, id: u32) {
        if let Some(f) = l.bodies.lock().unwrap().remove(&id) {
            f.cancelled.store(true, Ordering::Release);
            f.wake.notify_one();
        }
    }

    /// Called by a JS thread that found nothing to do and wants to sleep. Returns true if work arrived
    /// meanwhile (keep draining). Checked under the scheduler lock, so a concurrent push either makes this
    /// return true or sees the lane parked and wakes it.
    pub fn park(&self, lane: usize) -> bool {
        let l = &self.lanes[lane];
        let lq = l.queue.lock().unwrap();
        let mut sc = self.sched.lock().unwrap();
        if !lq.is_empty() || !sc.global.is_empty() {
            return true;
        }
        if sc.awake[lane] {
            sc.awake[lane] = false;
            sc.awake_count -= 1;
            sc.parked.push(lane);
        }
        false
    }

    /// Moves work into `out` as `[u32 count] events...`: this lane's own events first, then a fair share of
    /// the pooled requests (so one lane cannot hoard a backlog the others could work on). Returns bytes
    /// written (0 if none), or `-(needed)` if even the first item does not fit.
    pub fn drain(&self, lane: usize, out: &mut [u8]) -> i32 {
        let l = &self.lanes[lane];
        let mut lq = l.queue.lock().unwrap();
        let mut sc = self.sched.lock().unwrap();
        let first = match lq.first().or_else(|| sc.global.front()) {
            Some(it) => item_size(it),
            None => return 0,
        };
        if 4 + first > out.len() {
            return -((4 + first).min(i32::MAX as usize) as i32);
        }

        let mut pos = 4usize;
        let mut own = 0usize;
        for it in lq.iter() {
            let need = item_size(it);
            if pos + need > out.len() {
                break;
            }
            pos += need;
            own += 1;
        }
        let own_items: Vec<QItem> = lq.drain(..own).collect();
        drop(lq);

        let share = sc.global.len().div_ceil(sc.awake_count.max(1));
        let mut pooled: Vec<QItem> = Vec::new();
        while pooled.len() < share {
            // A client that already left costs no JS work at all.
            if matches!(sc.global.front(), Some(QItem::Request { tx, .. }) if tx.is_closed()) {
                sc.global.pop_front();
                continue;
            }
            let Some(front) = sc.global.front() else { break };
            let need = item_size(front);
            if pos + need > out.len() {
                break;
            }
            pos += need;
            pooled.push(sc.global.pop_front().unwrap());
        }
        drop(sc);

        let total: usize = own_items.iter().chain(pooled.iter()).map(|it| if let QItem::Events { count, .. } = it { *count as usize } else { 1 }).sum();
        out[0..4].copy_from_slice(&(total as u32).to_le_bytes());
        let mut pos = 4usize;
        let mut inflight = l.inflight.lock().unwrap();
        for it in own_items.into_iter().chain(pooled) {
            match it {
                QItem::Request { chunk, tx, io, cell, conn } => {
                    let id = self.new_id();
                    cell.v.store(((lane as u64 + 1) << 32) | id as u64, Ordering::Release);
                    if let Some(f) = &cell.body {
                        l.bodies.lock().unwrap().insert(id, f.clone());
                    }
                    cell.taken.notify_one();
                    out[pos] = 1;
                    out[pos + 1..pos + 5].copy_from_slice(&id.to_le_bytes());
                    out[pos + 5..pos + 5 + chunk.len()].copy_from_slice(&chunk);
                    pos += 5 + chunk.len();
                    inflight.insert(id, Slot::Response(tx, io, conn));
                }
                QItem::Event(e) => {
                    out[pos..pos + e.len()].copy_from_slice(&e);
                    pos += e.len();
                }
                QItem::Events { bytes, .. } => {
                    out[pos..pos + bytes.len()].copy_from_slice(&bytes);
                    pos += bytes.len();
                }
                QItem::Closed(id) => {
                    inflight.remove(&id);
                    out[pos] = 5;
                    out[pos + 1..pos + 5].copy_from_slice(&id.to_le_bytes());
                    pos += 5;
                }
                QItem::Aborted(id) => {
                    inflight.remove(&id);
                    out[pos] = 6;
                    out[pos + 1..pos + 5].copy_from_slice(&id.to_le_bytes());
                    pos += 5;
                }
            }
        }
        pos as i32
    }

    /// Executes a command batch `[u32 count] { u8 kind, ... }*` written by this lane's JS thread.
    pub fn command(&self, lane: usize, data: &[u8]) -> Result<(), String> {
        let lane_idx = lane;
        let l = &self.lanes[lane];
        let mut r = Reader::new(data);
        let count = r.u32()?;
        let inboxes = self.io.get();
        // Responses grouped per I/O thread; delivered after the loop with one wake each.
        let mut grouped: Vec<Vec<(oneshot::Sender<Reply>, Reply)>> = Vec::new();
        let mut ws_batch: WsBatch = Vec::new();
        let mut blob: Option<Bytes> = None;
        let mut inflight = l.inflight.lock().unwrap();
        // Consecutive WsSend commands share one hold on the socket map; any other command lets go of it first.
        let mut held: Option<std::sync::MutexGuard<IdMap<WsConn>>> = None;
        for _ in 0..count {
            let kind = r.u8()?;
            if kind != 5 {
                held = None;
            }
            match kind {
                // Respond(id, status, headers, body)
                1 => {
                    let (id, status, ct, hc) = (r.u32()?, r.u16()?, r.u8()?, r.u16()?);
                    let headers = skip_headers(&mut r, hc)?.to_vec();
                    let bl = r.u32()? as usize;
                    let body = r.take(bl)?.to_vec();
                    self.finish_body(l, id);
                    if let Some(Slot::Response(tx, io, _)) = inflight.remove(&id) {
                        let reply = Reply::Full(Full { status, ct, headers, header_count: hc, body });
                        match inboxes {
                            Some(v) if io < v.len() => {
                                if grouped.len() < v.len() {
                                    grouped.resize_with(v.len(), Vec::new);
                                }
                                grouped[io].push((tx, reply));
                            }
                            _ => {
                                let _ = tx.send(reply);
                            }
                        }
                    }
                }
                // WsPing(id, data): a ping frame to the peer
                16 => {
                    let id = r.u32()?;
                    let n = r.u32()? as usize;
                    let d = r.take(n)?;
                    self.ws_send_batched(id, WsOut::Msg(WsMsg::Ping(Bytes::copy_from_slice(d))), &mut ws_batch);
                }
                // WsPong(id, data)
                17 => {
                    let id = r.u32()?;
                    let n = r.u32()? as usize;
                    let d = r.take(n)?;
                    self.ws_send_batched(id, WsOut::Msg(WsMsg::Pong(Bytes::copy_from_slice(d))), &mut ws_batch);
                }
                // WsTerminate(id): drop the connection without a closing handshake
                18 => {
                    let id = r.u32()?;
                    if let Some(c) = self.ws_conns.lock().unwrap().get_mut(&id) {
                        if let Some(k) = c.kill.take() {
                            let _ = k.send(());
                        }
                    }
                }
                // WsPause(id) / WsResume(id): stop or restart reading from the socket
                19 => {
                    let id = r.u32()?;
                    self.ws_gate(id, true);
                }
                20 => {
                    let id = r.u32()?;
                    self.ws_gate(id, false);
                }
                // BodyAck(id, bytes): JS consumed that much of the streamed request body
                14 => {
                    let (id, n) = (r.u32()?, r.u32()?);
                    if let Some(f) = l.bodies.lock().unwrap().get(&id) {
                        f.credit.fetch_add(n as i64, Ordering::AcqRel);
                        f.wake.notify_one();
                    }
                }
                // BodyCancel(id): the handler no longer wants the rest of the body
                15 => {
                    let id = r.u32()?;
                    self.finish_body(l, id);
                }
                // Timeout(id, seconds): 0 disables the idle timeout of this request's connection until it completes
                11 => {
                    let (id, secs) = (r.u32()?, r.u16()?);
                    if let Some(Slot::Response(_, _, Some(conn))) = inflight.get(&id) {
                        conn.set_timeout(secs as u32);
                    }
                }
                // File(id, status, range flag, headers, path, content type)
                10 => {
                    let (id, status, flags, hc) = (r.u32()?, r.u16()?, r.u8()?, r.u16()?);
                    let headers = skip_headers(&mut r, hc)?.to_vec();
                    let pl = r.u16()? as usize;
                    let path = r.str(pl)?.to_string();
                    let cl = r.u16()? as usize;
                    let content_type = r.str(cl)?.to_string();
                    self.finish_body(l, id);
                    if let Some(Slot::Response(tx, _, _)) = inflight.remove(&id) {
                        let _ = tx.send(Reply::File(FileReply { status, range: flags & 1 != 0, headers, header_count: hc, path, content_type }));
                    }
                }
                // StreamStart(id, status, headers)
                2 => {
                    let (id, status, hc) = (r.u32()?, r.u16()?, r.u16()?);
                    let headers = skip_headers(&mut r, hc)?.to_vec();
                    self.finish_body(l, id);
                    if let Some(Slot::Response(tx, _, _)) = inflight.remove(&id) {
                        let (stx, srx) = mpsc::unbounded_channel();
                        if tx.send(Reply::Stream { lane: lane_idx, id, status, headers, header_count: hc, rx: srx }).is_ok() {
                            inflight.insert(id, Slot::Stream(stx));
                        }
                    }
                }
                // StreamChunk(id, data)
                3 => {
                    let id = r.u32()?;
                    let n = r.u32()? as usize;
                    let d = r.take(n)?;
                    if let Some(Slot::Stream(s)) = inflight.get(&id) {
                        if s.send(StreamMsg::Chunk(Bytes::copy_from_slice(d))).is_err() {
                            inflight.remove(&id);
                        }
                    }
                }
                // Upgrade(id, headers, protocol): accept the WebSocket upgrade of request `id`
                13 => {
                    let (id, hc) = (r.u32()?, r.u16()?);
                    let headers = skip_headers(&mut r, hc)?.to_vec();
                    let pl = r.u16()? as usize;
                    let protocol = r.str(pl)?.to_string();
                    self.finish_body(l, id);
                    if let Some(Slot::Response(tx, _, _)) = inflight.remove(&id) {
                        let _ = tx.send(Reply::Upgrade { headers, header_count: hc, protocol });
                    }
                }
                // StreamError(id): abort the connection (the body ends without its terminator)
                12 => {
                    if let Some(Slot::Stream(s)) = inflight.remove(&r.u32()?) {
                        let _ = s.send(StreamMsg::Abort);
                    }
                }
                // StreamEnd(id)
                4 => {
                    inflight.remove(&r.u32()?);
                }
                // WsSend(id, binary, data)
                5 => {
                    let (id, bin) = (r.u32()?, r.u8()?);
                    let n = r.u32()? as usize;
                    let d = r.take(n)?;
                    // One copy of the whole command buffer serves every message of this batch (slices share it).
                    let off = d.as_ptr() as usize - data.as_ptr() as usize;
                    let part = blob.get_or_insert_with(|| Bytes::copy_from_slice(data)).slice(off..off + n);
                    let msg = if bin != 0 { WsMsg::Binary(part) } else { WsMsg::Text(part) };
                    let conns = held.get_or_insert_with(|| self.ws_conns.lock().unwrap());
                    self.ws_send_held(conns, id, WsOut::Msg(msg), &mut ws_batch);
                }
                // WsClose(id, code, reason)
                6 => {
                    let (id, code) = (r.u32()?, r.u16()?);
                    let n = r.u16()? as usize;
                    let reason = r.str(n)?.to_string();
                    self.ws_send_batched(id, WsOut::Close(code, reason), &mut ws_batch);
                }
                // WsSubscribe(id, topic)
                7 => {
                    let id = r.u32()?;
                    let n = r.u16()? as usize;
                    let t = r.str(n)?.to_string();
                    self.subscribe(id, t);
                }
                // WsUnsubscribe(id, topic)
                8 => {
                    let id = r.u32()?;
                    let n = r.u16()? as usize;
                    let t = r.str(n)?;
                    self.unsubscribe(id, t);
                }
                // Publish(topic, binary, data, excludeId)
                9 => {
                    let n = r.u16()? as usize;
                    let topic = r.str(n)?;
                    let bin = r.u8()?;
                    let dl = r.u32()? as usize;
                    let d = r.take(dl)?;
                    let exclude = r.u32()?;
                    self.publish(topic, make_message(bin != 0, d)?, exclude, &mut ws_batch);
                }
                // CachePurge(count, tags...): drop the cached responses carrying one of the tags, or all of them when there are none
                21 => {
                    let n = r.u16()?;
                    let mut tags = Vec::with_capacity(n as usize);
                    for _ in 0..n {
                        let len = r.u16()? as usize;
                        tags.push(r.str(len)?.to_string());
                    }
                    self.cache.purge(&tags);
                }
                k => return Err(format!("unknown command {k}")),
            }
        }
        drop(inflight);
        self.flush_ws_batch(ws_batch);
        if let Some(v) = inboxes {
            for (io, mut items) in grouped.into_iter().enumerate() {
                match items.len() {
                    0 => {}
                    // A lone response costs one wake either way; the inbox would only add a hop.
                    1 => {
                        let (tx, reply) = items.pop().unwrap();
                        let _ = tx.send(reply);
                    }
                    _ => {
                        v[io].pending.fetch_add(items.len(), Ordering::Release);
                        v[io].q.lock().unwrap().extend(items);
                        v[io].notify.notify_one();
                    }
                }
            }
        }
        Ok(())
    }
}

fn make_message(binary: bool, d: &[u8]) -> Result<WsMsg, String> {
    // Text from JS is a JS string encoded as UTF-8 by the codec, valid by construction: no validation pass.
    Ok(if binary { WsMsg::Binary(Bytes::copy_from_slice(d)) } else { WsMsg::Text(Bytes::copy_from_slice(d)) })
}

