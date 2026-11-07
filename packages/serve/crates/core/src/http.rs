//! axum handler: static fast path, WebSocket upgrades, and queueing of everything else for JS.
use crate::state::{BodyFlow, Full, QItem, ReqCell, Reply, Shared, StreamMsg};
use crate::wire::{parse_headers, write_headers};
use axum::{
    body::Bytes,
    http::{self, header, request::Parts, HeaderValue, Method, StatusCode},
    response::Response,
};
use bytes::BytesMut;
use http_body::{Body as HttpBody, Frame, SizeHint};
use http_body_util::BodyExt;
use futures_util::Stream;
use std::{
    net::SocketAddr,
    sync::atomic::{AtomicI64, AtomicU64, Ordering},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::sync::{mpsc, oneshot};

/// Response body without boxing: a complete body, a JS-driven stream, or a file.
pub enum RBody {
    Full(Option<Bytes>),
    Stream(StreamBody),
    File(crate::file::FileBody),
}

impl HttpBody for RBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        match self.get_mut() {
            RBody::Full(b) => Poll::Ready(b.take().map(|b| Ok(Frame::data(b)))),
            RBody::Stream(s) => match Pin::new(s).poll_next(cx) {
                Poll::Ready(Some(Ok(b))) => Poll::Ready(Some(Ok(Frame::data(b)))),
                Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(axum::Error::new(e)))),
                Poll::Ready(None) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            },
            RBody::File(f) => match f.poll_next(cx) {
                Poll::Ready(Some(Ok(b))) => Poll::Ready(Some(Ok(Frame::data(b)))),
                Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(axum::Error::new(e)))),
                Poll::Ready(None) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            },
        }
    }

    fn is_end_stream(&self) -> bool {
        match self {
            RBody::Full(b) => b.is_none(),
            RBody::Stream(_) => false,
            RBody::File(_) => false,
        }
    }

    fn size_hint(&self) -> SizeHint {
        match self {
            RBody::Full(Some(b)) => SizeHint::with_exact(b.len() as u64),
            RBody::Full(None) => SizeHint::with_exact(0),
            RBody::Stream(_) => SizeHint::default(),
            RBody::File(_) => SizeHint::default(),
        }
    }
}

pub type Resp = Response<RBody>;

fn empty(status: StatusCode) -> Resp {
    let mut r = Response::new(RBody::Full(None));
    *r.status_mut() = status;
    r
}

fn content_type(code: u8) -> Option<HeaderValue> {
    match code {
        1 => Some(HeaderValue::from_static("text/plain;charset=utf-8")),
        2 => Some(HeaderValue::from_static("application/json;charset=utf-8")),
        3 => Some(HeaderValue::from_static("application/octet-stream")),
        _ => None,
    }
}

fn write_method(out: &mut Vec<u8>, m: &Method) {
    let code = match m.as_str() {
        "GET" => 0,
        "POST" => 1,
        "PUT" => 2,
        "DELETE" => 3,
        "PATCH" => 4,
        "HEAD" => 5,
        "OPTIONS" => 6,
        "TRACE" => 7,
        "CONNECT" => 8,
        _ => 255,
    };
    out.push(code);
    if code == 255 {
        let s = m.as_str().as_bytes();
        out.push(s.len().min(255) as u8);
        out.extend_from_slice(&s[..s.len().min(255)]);
    }
}

fn url_of(parts: &Parts) -> &str {
    // CONNECT carries an authority ("host:port") instead of a path.
    parts.uri.path_and_query().map(|p| p.as_str()).or_else(|| parts.uri.authority().map(|a| a.as_str())).unwrap_or("/")
}

/// Peer address as `u8 kind (0 none, 4, 6)`, address bytes, `u16 port`. IPv4-mapped IPv6 is reported as IPv4.
fn write_peer(out: &mut Vec<u8>, peer: Option<SocketAddr>) {
    match peer {
        Some(SocketAddr::V4(a)) => {
            out.push(4);
            out.extend_from_slice(&a.ip().octets());
            out.extend_from_slice(&a.port().to_le_bytes());
        }
        Some(SocketAddr::V6(a)) => match a.ip().to_ipv4_mapped() {
            Some(v4) => {
                out.push(4);
                out.extend_from_slice(&v4.octets());
                out.extend_from_slice(&a.port().to_le_bytes());
            }
            None => {
                out.push(6);
                out.extend_from_slice(&a.ip().octets());
                out.extend_from_slice(&a.port().to_le_bytes());
            }
        },
        None => out.push(0),
    }
}

/// Request bodies above this size are streamed to JS instead of being handed over whole.
const INLINE_BODY: usize = 256 * 1024;
/// How much streamed body may be in flight to JS before Rust waits for it to be consumed.
const BODY_WINDOW: i64 = 2 * 1024 * 1024;

fn body_event(kind: u8, id: u32, data: &[u8]) -> Vec<u8> {
    let mut e = Vec::with_capacity(9 + data.len());
    e.push(kind);
    e.extend_from_slice(&id.to_le_bytes());
    if kind == 7 {
        e.extend_from_slice(&(data.len() as u32).to_le_bytes());
        e.extend_from_slice(data);
    }
    e
}

/// Feeds the rest of a request body to the lane that took the request, as far as the credit window allows.
async fn stream_rest<B>(sh: Arc<Shared>, cell: Arc<ReqCell>, flow: Arc<BodyFlow>, mut body: Pin<Box<B>>, mut total: usize)
where
    B: HttpBody<Data = Bytes> + Send + 'static,
{
    // Chunks are tagged with the id a lane assigns when it takes the request; wait for that.
    while cell.v.load(Ordering::Acquire) == 0 {
        if flow.cancelled.load(Ordering::Acquire) {
            return;
        }
        cell.taken.notified().await;
    }
    let v = cell.v.load(Ordering::Acquire);
    let (lane, id) = (((v >> 32) - 1) as usize, v as u32);
    loop {
        if flow.cancelled.load(Ordering::Acquire) {
            return;
        }
        if flow.credit.load(Ordering::Acquire) <= 0 {
            flow.wake.notified().await; // an ack or a cancel
            continue;
        }
        tokio::select! {
            frame = body.frame() => match frame {
                Some(Ok(frame)) => {
                    let Ok(d) = frame.into_data() else { continue };
                    total += d.len();
                    if total > sh.max_body {
                        sh.push(lane, QItem::Event(body_event(13, id, &[])));
                        return;
                    }
                    flow.credit.fetch_sub(d.len() as i64, Ordering::AcqRel);
                    sh.push(lane, QItem::Event(body_event(7, id, &d)));
                }
                Some(Err(_)) => {
                    sh.push(lane, QItem::Event(body_event(9, id, &[])));
                    return;
                }
                None => {
                    sh.push(lane, QItem::Event(body_event(8, id, &[])));
                    return;
                }
            },
            _ = flow.wake.notified() => {} // re-check the cancel flag
        }
    }
}

/// Dropped with the request future when the client disconnects before the response is ready.
struct AbortGuard {
    sh: Arc<Shared>,
    cell: Arc<ReqCell>,
    done: bool,
    conn: Option<Arc<crate::tpc::ConnState>>,
}

impl Drop for AbortGuard {
    fn drop(&mut self) {
        self.sh.pending_requests.fetch_sub(1, Ordering::Relaxed);
        if let Some(c) = &self.conn {
            c.request_ended();
        }
        // However the request ended, nothing will read the rest of its body.
        if let Some(f) = &self.cell.body {
            f.cancelled.store(true, Ordering::Release);
            f.wake.notify_one();
        }
        if self.done {
            return;
        }
        let v = self.cell.v.load(Ordering::Acquire);
        if v != 0 {
            // JS already took the request: tell its lane. (If not, the queued request is skipped at drain.)
            self.sh.push(((v >> 32) - 1) as usize, QItem::Aborted(v as u32));
        }
    }
}

/// The request handler, generic over the body so hyper's `Incoming` is used directly (no boxing).
/// Weak comparison of an `If-None-Match` list (or `*`) against one entity tag.
fn etag_matches(list: &[u8], tag: &[u8]) -> bool {
    let strip = |t: &[u8]| -> Vec<u8> {
        let t = t.trim_ascii();
        t.strip_prefix(b"W/").unwrap_or(t).to_vec()
    };
    let tag = strip(tag);
    list.split(|b| *b == b',').any(|t| t.trim_ascii() == b"*" || strip(t) == tag)
}

pub async fn handle<B>(sh: Arc<Shared>, peer: Option<SocketAddr>, conn: Option<Arc<crate::tpc::ConnState>>, req: http::Request<B>) -> Resp
where
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: Into<axum::BoxError>,
{
    let (mut parts, body) = req.into_parts();
    // HTTP/2 carries the host in :authority; give JS the Host header it expects.
    if parts.version == http::Version::HTTP_2 && !parts.headers.contains_key(header::HOST) {
        if let Some(v) = parts.uri.authority().and_then(|a| header::HeaderValue::from_str(a.as_str()).ok()) {
            parts.headers.insert(header::HOST, v);
        }
    }

    // HEAD is answered from GET routes (the body is dropped by hyper) unless a HEAD route exists.
    let static_method = if parts.method == Method::HEAD && !sh.statics.contains_key("HEAD") { "GET" } else { parts.method.as_str() };
    if let Some(by_path) = sh.statics.get(static_method) {
        if let Some(s) = by_path.get(parts.uri.path()) {
            if let (Some(tag), Some(inm)) = (&s.etag, parts.headers.get(header::IF_NONE_MATCH)) {
                if etag_matches(inm.as_bytes(), tag.as_bytes()) {
                    let mut r = Response::new(RBody::Full(None));
                    *r.status_mut() = StatusCode::NOT_MODIFIED;
                    r.headers_mut().insert(header::ETAG, tag.clone());
                    return r;
                }
            }
            let mut r = Response::new(RBody::Full(Some(s.body.clone())));
            *r.status_mut() = s.status;
            *r.headers_mut() = s.headers.clone();
            return r;
        }
    }

    // A WebSocket upgrade is offered to JS like any request; JS accepts it (or answers with a normal response).
    let mut upgrade = None;
    if parts.headers.get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket")) && sh.ws_match(parts.uri.path()) {
        match ws_handshake(&sh, &mut parts) {
            Ok(u) => upgrade = Some(u),
            Err(rej) => return rej,
        }
    }

    // A declared length over the limit is refused before a byte is read.
    let declared = parts.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > sh.max_body as u64) {
        return empty(StatusCode::PAYLOAD_TOO_LARGE);
    }
    // Most requests (GETs) have no body: skip the machinery. Small bodies travel with the request; a big one is
    // streamed (the handler starts as soon as the first part is in).
    let mut body_bytes: Vec<u8> = Vec::new();
    let mut rest: Option<Pin<Box<B>>> = None;
    if !body.is_end_stream() {
        let mut b = Box::pin(body);
        loop {
            match b.frame().await {
                Some(Ok(frame)) => {
                    if let Ok(d) = frame.into_data() {
                        body_bytes.extend_from_slice(&d);
                        if body_bytes.len() > sh.max_body {
                            return empty(StatusCode::PAYLOAD_TOO_LARGE);
                        }
                        if body_bytes.len() > INLINE_BODY {
                            rest = Some(b);
                            break;
                        }
                    }
                }
                Some(Err(_)) => return empty(StatusCode::BAD_REQUEST),
                None => break,
            }
        }
    }
    let flow = rest.is_some().then(|| Arc::new(BodyFlow { credit: AtomicI64::new(BODY_WINDOW), wake: tokio::sync::Notify::new(), cancelled: std::sync::atomic::AtomicBool::new(false) }));
    let body = Bytes::from(body_bytes);

    let url = url_of(&parts);
    let mut chunk = Vec::with_capacity(64 + url.len() + parts.headers.len() * 32 + body.len());
    write_method(&mut chunk, &parts.method);
    let secure = conn.as_ref().is_some_and(|c| c.tls.load(Ordering::Relaxed));
    chunk.push(upgrade.is_some() as u8 | (flow.is_some() as u8) << 1 | (secure as u8) << 2); // flags: bit 0 = can be upgraded, bit 1 = body streamed, bit 2 = HTTPS
    write_peer(&mut chunk, peer);
    chunk.extend_from_slice(&(url.len() as u32).to_le_bytes());
    chunk.extend_from_slice(url.as_bytes());
    write_headers(&mut chunk, &parts.headers);
    chunk.extend_from_slice(&(body.len() as u32).to_le_bytes());
    chunk.extend_from_slice(&body);

    let (tx, rx) = oneshot::channel();
    let cell = Arc::new(ReqCell { v: AtomicU64::new(0), taken: tokio::sync::Notify::new(), body: flow.clone() });
    sh.push_request(chunk, tx, crate::tpc::io_index(), cell.clone(), conn.clone(), upgrade.is_some());
    if let (Some(flow), Some(b)) = (flow, rest) {
        tokio::spawn(stream_rest(sh.clone(), cell.clone(), flow, b, body.len()));
    }
    sh.pending_requests.fetch_add(1, Ordering::Relaxed);
    if let Some(c) = &conn {
        c.request_started();
    }
    let mut guard = AbortGuard { sh: sh.clone(), cell, done: false, conn: conn.clone() };

    let reply = rx.await;
    guard.done = true;
    let cell_value = guard.cell.v.load(Ordering::Acquire);
    // A per-request timeout override ends with the request, unless the connection now belongs to a stream.
    if let (Some(c), Ok(Reply::Full(_) | Reply::File(_))) = (&conn, &reply) {
        c.reset_timeout();
    }
    match reply {
        Ok(Reply::Full(Full { status, ct, headers, header_count, body })) => {
            // 204, 205 and 304 never carry content (205 gets "content-length: 0" from hyper, 204/304 no length at all).
            let no_body = matches!(status, 204 | 205 | 304);
            let mut r = Response::new(if no_body { RBody::Full(None) } else { RBody::Full(Some(Bytes::from(body))) });
            *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            if let Some(v) = content_type(ct).filter(|_| !no_body) {
                r.headers_mut().insert(header::CONTENT_TYPE, v);
            }
            if header_count > 0 {
                parse_headers(&headers, header_count, r.headers_mut());
                // The length and framing are the server's to set: a handler's own Content-Length would desynchronize the
                // connection when it disagrees with the body. A HEAD response has no body to disagree with, and its
                // Content-Length is the length of the entity a GET would return, so the handler's stays.
                if parts.method != Method::HEAD {
                    r.headers_mut().remove(header::CONTENT_LENGTH);
                }
                r.headers_mut().remove(header::TRANSFER_ENCODING);
            }
            if no_body {
                // No content means no representation metadata either (RFC 9110 sections 15.3.5, 15.3.6, 15.4.5).
                r.headers_mut().remove(header::CONTENT_TYPE);
                if status != 205 {
                    r.headers_mut().remove(header::CONTENT_LENGTH);
                }
            }
            r
        }
        Ok(Reply::Upgrade { headers, header_count, protocol }) => match upgrade {
            Some(w) => finish_upgrade(sh, w, &parts, peer, conn, cell_value, headers, header_count, protocol),
            None => empty(StatusCode::INTERNAL_SERVER_ERROR), // JS tried to upgrade a request that was not an upgrade
        },
        Ok(Reply::File(f)) => crate::file::serve(&parts.method, &parts.headers, f).await,
        Ok(Reply::Stream { lane, id, status, headers, header_count, rx }) => {
            let mut r = Response::new(RBody::Stream(StreamBody { rx, sh, lane, id, finished: false, abort_next: false, consumed: 0 }));
            *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            parse_headers(&headers, header_count, r.headers_mut());
            r.headers_mut().remove(header::CONTENT_LENGTH);
            r.headers_mut().remove(header::TRANSFER_ENCODING);
            r
        }
        Err(_) if sh.stopping.load(Ordering::Relaxed) => {
            // The server is going down: tell the client to retry elsewhere rather than blaming the handler.
            let mut r = empty(StatusCode::SERVICE_UNAVAILABLE);
            r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            r
        }
        Err(_) => empty(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Body of a streaming (SSE / chunked) response. Dropping it before JS ended the stream means the client left.
pub struct StreamBody {
    rx: mpsc::UnboundedReceiver<StreamMsg>,
    sh: Arc<Shared>,
    lane: usize,
    id: u32,
    finished: bool,
    /// An abort was seen while merging chunks: deliver what was merged, then fail.
    abort_next: bool,
    /// Bytes handed to the connection since JS was last told: JS holds its producer back while too many are unacknowledged.
    consumed: usize,
}

/// JS may have this many bytes of a streamed response in flight before its producer waits (see `Stream.drained`).
const STREAM_ACK_EVERY: usize = 128 * 1024;

impl StreamBody {
    fn ack(&mut self) {
        if self.consumed > 0 {
            let mut e = Vec::with_capacity(9);
            e.push(14);
            e.extend_from_slice(&self.id.to_le_bytes());
            e.extend_from_slice(&(self.consumed.min(u32::MAX as usize) as u32).to_le_bytes());
            self.consumed = 0;
            self.sh.push(self.lane, QItem::Event(e));
        }
    }
}

impl Stream for StreamBody {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.abort_next {
            self.finished = true; // the client sees a broken stream, not a clean end
            return Poll::Ready(Some(Err(std::io::Error::other("stream aborted by the application"))));
        }
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(StreamMsg::Chunk(first))) => {
                // Merge whatever else is already queued into one write instead of one syscall per chunk.
                let mut merged: Option<BytesMut> = None;
                loop {
                    match self.rx.try_recv() {
                        Ok(StreamMsg::Chunk(next)) => {
                            let m = merged.get_or_insert_with(|| {
                                let mut m = BytesMut::with_capacity(first.len() + next.len());
                                m.extend_from_slice(&first);
                                m
                            });
                            m.extend_from_slice(&next);
                            if m.len() >= 64 * 1024 {
                                break;
                            }
                        }
                        Ok(StreamMsg::Abort) => {
                            self.abort_next = true;
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let out = merged.map_or(first, BytesMut::freeze);
                self.consumed += out.len();
                if self.consumed >= STREAM_ACK_EVERY {
                    self.ack();
                }
                Poll::Ready(Some(Ok(out)))
            }
            Poll::Ready(Some(StreamMsg::Abort)) => {
                self.finished = true;
                Poll::Ready(Some(Err(std::io::Error::other("stream aborted by the application"))))
            }
            Poll::Ready(None) => {
                self.finished = true;
                Poll::Ready(None)
            }
            Poll::Pending => {
                self.ack(); // the queue is dry: a producer waiting for room can go on
                Poll::Pending
            }
        }
    }
}

impl Drop for StreamBody {
    fn drop(&mut self) {
        if !self.finished {
            self.sh.push(self.lane, QItem::Closed(self.id));
        }
    }
}

// ---------- WebSocket ----------

/// A validated upgrade request, not yet answered.
pub struct Upg {
    on_upgrade: hyper::upgrade::OnUpgrade,
    key: Vec<u8>,
    offered_protocols: String,
    /// permessage-deflate as agreed with the peer, and the header that says so.
    deflate: Option<(crate::deflate::Params, String)>,
}

fn refuse(status: StatusCode) -> Resp {
    empty(status)
}

/// Checks a WebSocket handshake (RFC 6455 section 4.2.1) and negotiates the extension.
#[allow(clippy::result_large_err)] // the error is the response to send: a cold path, not worth boxing
fn ws_handshake(sh: &Shared, parts: &mut Parts) -> Result<Upg, Resp> {
    if parts.method != Method::GET || parts.version != http::Version::HTTP_11 {
        return Err(refuse(StatusCode::BAD_REQUEST));
    }
    let h = &parts.headers;
    let has_upgrade_token = h.get(header::CONNECTION).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")));
    if !has_upgrade_token {
        return Err(refuse(StatusCode::BAD_REQUEST));
    }
    if h.get(header::SEC_WEBSOCKET_VERSION).map(|v| v.as_bytes()) != Some(b"13") {
        let mut r = refuse(StatusCode::UPGRADE_REQUIRED);
        r.headers_mut().insert(header::SEC_WEBSOCKET_VERSION, HeaderValue::from_static("13"));
        return Err(r);
    }
    let key = match h.get(header::SEC_WEBSOCKET_KEY) {
        Some(k) if k.as_bytes().len() == 24 => k.as_bytes().to_vec(),
        _ => return Err(refuse(StatusCode::BAD_REQUEST)),
    };
    let deflate = sh.ws.deflate.as_ref().and_then(|cfg| crate::deflate::negotiate(h.get(header::SEC_WEBSOCKET_EXTENSIONS)?.to_str().ok()?, cfg));
    let offered_protocols = h.get(header::SEC_WEBSOCKET_PROTOCOL).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let Some(on_upgrade) = parts.extensions.remove::<hyper::upgrade::OnUpgrade>() else {
        return Err(refuse(StatusCode::BAD_REQUEST));
    };
    Ok(Upg { on_upgrade, key, offered_protocols, deflate })
}

#[allow(clippy::too_many_arguments)]
fn finish_upgrade(
    sh: Arc<Shared>,
    up: Upg,
    parts: &Parts,
    peer: Option<SocketAddr>,
    conn: Option<Arc<crate::tpc::ConnState>>,
    cell: u64,
    extra_headers: Vec<u8>,
    extra_count: u16,
    protocol: String,
) -> Resp {
    if let Some(c) = &conn {
        c.ws.store(true, Ordering::Relaxed); // from now on this connection follows the WebSocket idle timeout
        c.ws_started(&sh); // counted as open until the session ends, so a graceful close waits for its Close frame
    }
    let lane = if cell == 0 { sh.pick_lane() } else { ((cell >> 32) - 1) as usize };
    let req_id = cell as u32;
    let id = sh.new_id();
    // Open event: kind 2, ws id, id of the upgrade request (JS keeps the data it attached there), peer, url, headers.
    let url = url_of(parts);
    let mut open = Vec::with_capacity(40 + url.len() + parts.headers.len() * 32);
    open.push(2);
    open.extend_from_slice(&id.to_le_bytes());
    open.extend_from_slice(&req_id.to_le_bytes());
    write_peer(&mut open, peer);
    open.extend_from_slice(&(url.len() as u32).to_le_bytes());
    open.extend_from_slice(url.as_bytes());
    write_headers(&mut open, &parts.headers);

    let mut r = Response::new(RBody::Full(None));
    *r.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let h = r.headers_mut();
    h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    if let Some(v) = crate::uws::accept_key(&up.key).and_then(|a| HeaderValue::from_str(&a).ok()) {
        h.insert(header::SEC_WEBSOCKET_ACCEPT, v);
    }
    let deflate = up.deflate.as_ref().map(|(p, _)| *p);
    if let Some((_, answer)) = &up.deflate {
        if let Ok(v) = HeaderValue::from_str(answer) {
            h.insert(header::SEC_WEBSOCKET_EXTENSIONS, v);
        }
    }
    if !protocol.is_empty() && up.offered_protocols.split(',').any(|p| p.trim() == protocol) {
        if let Ok(v) = HeaderValue::from_str(&protocol) {
            h.insert(header::SEC_WEBSOCKET_PROTOCOL, v);
        }
    }
    if extra_count > 0 {
        parse_headers(&extra_headers, extra_count, r.headers_mut());
    }

    let sh2 = sh.clone();
    tokio::spawn(async move {
        if let Ok(upgraded) = up.on_upgrade.await {
            let args = crate::wsconn::Args { sh: sh2.clone(), lane, id, open, conn: conn.clone(), deflate };
            // The socket hyper was given, without its wrapper layers (and the bytes it had already read).
            match upgraded.downcast::<hyper_util::rt::TokioIo<crate::tpc::Io>>() {
                Ok(parts) => crate::wsconn::run(args, parts.io.into_inner(), &parts.read_buf).await,
                Err(upgraded) => crate::wsconn::run(args, hyper_util::rt::TokioIo::new(upgraded), &[]).await,
            }
        }
        if let Some(c) = &conn {
            c.ws_ended(&sh2);
        }
    });
    r
}
