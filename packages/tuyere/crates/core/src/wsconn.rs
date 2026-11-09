//! One WebSocket connection, in one task, on uWebSockets' protocol layer (see `uws.rs`).
//!
//! The structure follows Bun's `WebSocketContext`: bytes are read into a buffer shared by every connection of the I/O
//! thread, parsed and unmasked in place, and each message is handed to JS; pieces of a fragmented message are
//! gathered, a compressed one is inflated, text is checked for UTF-8; pings are answered automatically; a close
//! frame ends the connection with the handshake completed. Everything written by one pass (auto-pongs, queued
//! sends, a close) leaves in a single `write`, the equivalent of Bun's cork.

use crate::deflate::{Deflater, Inflater, Params};
use crate::state::{PauseGate, QItem, Shared, WsMsg, WsOut};
use crate::tpc::ConnState;
use crate::uws::{self, Handler, Parser};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

/// Bytes read at a time. One buffer of this size serves every connection of an I/O thread (parsing is synchronous, so
/// a connection only borrows it for the length of one read), like uSockets' shared receive buffer.
const READ_CHUNK: usize = 128 * 1024;
/// Slack around the data for the parser's in-place work.
const PAD: usize = 16;
/// Messages below this size are sent uncompressed (the extension's overhead would exceed the saving).
const MIN_COMPRESS: usize = 64;
/// How long we wait for the peer's answer to a Close we sent.
const CLOSE_WAIT: Duration = Duration::from_secs(1);
/// Auto-pongs are skipped above this much unsent output (the peer could otherwise grow our memory with pings).
const MAX_PONG_BACKLOG: usize = 16 * 1024 * 1024;

thread_local! {
    static RBUF: RefCell<Vec<u8>> = RefCell::new(vec![0u8; PAD + READ_CHUNK + PAD + 16]);
}

pub fn ws_simple_event(kind: u8, id: u32) -> Vec<u8> {
    let mut e = Vec::with_capacity(5);
    e.push(kind);
    e.extend_from_slice(&id.to_le_bytes());
    e
}

pub fn ws_data_event(kind: u8, id: u32, data: &[u8]) -> Vec<u8> {
    let mut e = Vec::with_capacity(9 + data.len());
    e.push(kind);
    e.extend_from_slice(&id.to_le_bytes());
    e.extend_from_slice(&(data.len() as u32).to_le_bytes());
    e.extend_from_slice(data);
    e
}

/// Appends a message event to `e`.
pub fn write_message_event(e: &mut Vec<u8>, id: u32, binary: bool, data: &[u8]) {
    e.reserve(10 + data.len());
    e.push(3);
    e.extend_from_slice(&id.to_le_bytes());
    // 0 text, 1 binary, 2 text that is plain ASCII (JS decodes that with the cheaper Latin-1 path)
    e.push(if binary { 1 } else if data.is_ascii() { 2 } else { 0 });
    e.extend_from_slice(&(data.len() as u32).to_le_bytes());
    e.extend_from_slice(data);
}

/// What the parser's callbacks need and produce while one read is parsed.
struct Session {
    id: u32,
    max: usize,
    /// permessage-deflate was negotiated: RSV1 is allowed on data frames.
    deflate_on: bool,
    /// The message being parsed is compressed.
    compressed: bool,
    inflater: Option<Inflater>,
    /// A data message in pieces, and a control frame in pieces.
    msg: Vec<u8>,
    ctl: Vec<u8>,
    /// Events for JS from this read, serialized back to back (handed over together).
    events: Vec<u8>,
    event_count: u32,
    /// Frames to send because of what was read (auto-pongs).
    out: Vec<u8>,
    close_sent: bool,
    /// The peer's close frame: status code and reason.
    peer_close: Option<(u16, Vec<u8>)>,
    /// A protocol violation: the close code to send and why.
    fail: Option<(u16, String)>,
    /// Unsent output the pong rule looks at.
    backlog: Arc<AtomicUsize>,
}

impl Session {
    fn fail_with(&mut self, code: u16, why: &str) -> bool {
        if self.fail.is_none() {
            self.fail = Some((code, why.to_string()));
        }
        true
    }

    fn emit(&mut self, opcode: i32, data: &[u8]) -> bool {
        if opcode == uws::OP_TEXT && std::str::from_utf8(data).is_err() {
            return self.fail_with(1007, "Received invalid UTF-8");
        }
        write_message_event(&mut self.events, self.id, opcode == uws::OP_BINARY, data);
        self.event_count += 1;
        false
    }

    fn control(&mut self, opcode: i32, mut payload: Vec<u8>) -> bool {
        match opcode {
            uws::OP_CLOSE => {
                let c = uws::parse_close(&mut payload);
                match c.invalid {
                    Some((code, why)) => self.fail_with(code, why),
                    None => {
                        self.peer_close = Some((c.code, c.reason));
                        true
                    }
                }
            }
            uws::OP_PING => {
                if !self.close_sent && self.out.len() + self.backlog.load(Ordering::Relaxed) <= MAX_PONG_BACKLOG {
                    uws::write_frame(&mut self.out, uws::OP_PONG, &payload, false, true);
                }
                self.events.extend_from_slice(&ws_data_event(10, self.id, &payload));
                self.event_count += 1;
                false
            }
            uws::OP_PONG => {
                self.events.extend_from_slice(&ws_data_event(11, self.id, &payload));
                self.event_count += 1;
                false
            }
            _ => false,
        }
    }
}

impl Handler for Session {
    fn set_compressed(&mut self) -> bool {
        if self.deflate_on {
            self.compressed = true;
        }
        self.deflate_on
    }

    fn refuse_length(&mut self, len: u64) -> bool {
        len > self.max as u64
    }

    fn fragment(&mut self, data: &mut [u8], remaining: u32, opcode: i32, fin: bool) -> bool {
        let last = remaining == 0 && fin;
        if opcode < uws::OP_CLOSE {
            // The common case: a whole, uncompressed message in one piece goes straight from the read buffer.
            if last && self.msg.is_empty() && !self.compressed {
                return self.emit(opcode, data);
            }
            if self.msg.len() + data.len() > self.max {
                return self.fail_with(1009, "Received too big message");
            }
            self.msg.extend_from_slice(data);
            if !last {
                return false;
            }
            let mut m = std::mem::take(&mut self.msg);
            if self.compressed {
                self.compressed = false;
                let inflated = match self.inflater.as_mut() {
                    Some(i) => i.inflate(m, self.max),
                    None => Err(crate::deflate::Fail::Bad),
                };
                m = match inflated {
                    Ok(v) => v,
                    Err(crate::deflate::Fail::TooBig) => return self.fail_with(1009, "Received too big message, or other inflation error"),
                    Err(crate::deflate::Fail::Bad) => return self.fail_with(1007, "Received invalid compressed data"),
                };
            }
            self.emit(opcode, &m)
        } else {
            // Control frames are at most 125 bytes, but may still arrive in pieces.
            if last && self.ctl.is_empty() {
                return self.control(opcode, data.to_vec());
            }
            self.ctl.extend_from_slice(data);
            if !last {
                return false;
            }
            let payload = std::mem::take(&mut self.ctl);
            self.control(opcode, payload)
        }
    }

    fn fail(&mut self, _kind: i32, close_code: u16, _detail: u64, diag: &str) {
        self.fail_with(close_code, diag);
    }
}

/// Everything `run` needs besides the socket.
pub struct Args {
    pub sh: Arc<Shared>,
    pub lane: usize,
    pub id: u32,
    pub open: Vec<u8>,
    pub conn: Option<Arc<ConnState>>,
    pub deflate: Option<Params>,
}

fn data_len(m: &WsMsg) -> usize {
    match m {
        WsMsg::Text(b) | WsMsg::Binary(b) => b.len(),
        _ => 0,
    }
}

/// Appends the frame for `m`, compressed if the connection negotiated it and the message is worth it.
fn append(out: &mut Vec<u8>, m: &WsMsg, deflater: &mut Option<Deflater>) {
    let (op, payload) = match m {
        WsMsg::Text(b) => (uws::OP_TEXT, b),
        WsMsg::Binary(b) => (uws::OP_BINARY, b),
        WsMsg::Ping(b) => (uws::OP_PING, b),
        WsMsg::Pong(b) => (uws::OP_PONG, b),
    };
    if let Some(d) = deflater {
        if (op == uws::OP_TEXT || op == uws::OP_BINARY) && payload.len() >= MIN_COMPRESS {
            let packed = d.deflate(payload);
            uws::write_frame(out, op, &packed, true, true);
            return;
        }
    }
    uws::write_frame(out, op, payload, false, true);
}

/// Runs the connection until it ends; `leftover` holds bytes hyper had already read after the handshake.
pub async fn run<IO>(a: Args, mut io: IO, leftover: &[u8])
where
    IO: AsyncRead + AsyncWrite + Unpin,
{
    let Args { sh, lane, id, open, conn, deflate } = a;
    let (tx, mut rx) = mpsc::unbounded_channel::<WsOut>();
    let pending = Arc::new(AtomicUsize::new(0));
    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
    let gate = Arc::new(PauseGate { paused: AtomicBool::new(false), wake: tokio::sync::Notify::new() });
    let over = Arc::new(AtomicBool::new(false));
    sh.ws_register(id, lane, tx, pending.clone(), kill_tx, gate.clone(), over.clone());
    sh.push(lane, QItem::Event(open));

    let max = sh.ws.max_message;
    let ping_every = sh.ws.ping_secs as u64;
    let drain_limit = sh.ws.backpressure;
    let mut deflater = deflate.filter(|p| p.compress).map(|p| Deflater::new(p.server_bits, p.server_no_context));
    let mut s = Session {
        id,
        max,
        deflate_on: deflate.is_some(),
        compressed: false,
        inflater: deflate.map(|p| Inflater::new(p.client_no_context)),
        msg: Vec::new(),
        ctl: Vec::new(),
        events: Vec::new(),
        event_count: 0,
        out: Vec::new(),
        close_sent: false,
        peer_close: None,
        fail: None,
        backlog: pending.clone(),
    };
    let mut parser = Parser::new();
    let pre = PAD.max(Parser::pre_padding());
    let mut wbuf: Vec<u8> = Vec::with_capacity(4096);

    // The code and reason reported to JS when the connection ends.
    let mut code = 1006u16;
    let mut reason: Vec<u8> = Vec::new();

    let idle = async {
        match &conn {
            Some(c) => c.idle_expired().await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(idle);
    let far = Duration::from_secs(60 * 60 * 24 * 365);
    let mut give_up = Box::pin(tokio::time::sleep(far));
    let mut ping = Box::pin(tokio::time::sleep(if ping_every > 0 { Duration::from_secs(ping_every) } else { far }));

    // What hyper read past the handshake (a client may send its first frame at once).
    let mut ended = false;
    for piece in leftover.chunks(READ_CHUNK) {
        RBUF.with(|b| {
            let mut b = b.borrow_mut();
            b[pre..pre + piece.len()].copy_from_slice(piece);
            parser.consume(&mut b, pre, piece.len(), &mut s);
        });
        if s.fail.is_some() || s.peer_close.is_some() {
            ended = true;
            break;
        }
    }
    sh.push_events(lane, &mut s.events, &mut s.event_count);

    macro_rules! write_out {
        ($buf:expr) => {{
            if $buf.is_empty() {
                true
            } else {
                let r = tokio::select! {
                    r = io.write_all(&$buf) => r.is_ok(),
                    _ = &mut kill_rx => false,
                    _ = &mut idle => false,
                };
                $buf.clear();
                if $buf.capacity() > 512 * 1024 {
                    $buf.shrink_to(4096);
                }
                r
            }
        }};
    }

    'main: loop {
        // Frames made while parsing (auto-pongs, the answer to a violation or to a close) go out first.
        if ended || s.fail.is_some() || s.peer_close.is_some() {
            if let Some((c, why)) = s.fail.take() {
                if !s.close_sent {
                    uws::write_close(&mut s.out, c, why.as_bytes());
                }
                code = c;
                reason = why.into_bytes();
            } else if let Some((c, r)) = s.peer_close.take() {
                if !s.close_sent {
                    // Echo the code back (1005, "no status", is answered with an empty close).
                    uws::write_close(&mut s.out, c, b"");
                }
                code = c;
                reason = r;
            }
            let mut out = std::mem::take(&mut s.out);
            let _ = write_out!(out);
            break 'main;
        }
        if !s.out.is_empty() {
            let mut out = std::mem::take(&mut s.out);
            if !write_out!(out) {
                break 'main;
            }
        }

        tokio::select! {
            _ = &mut kill_rx => break 'main,
            _ = &mut idle => break 'main,
            _ = &mut give_up, if s.close_sent => break 'main,
            _ = &mut ping, if ping_every > 0 && !s.close_sent => {
                uws::write_frame(&mut wbuf, uws::OP_PING, b"", false, true);
                ping.as_mut().reset(Instant::now() + Duration::from_secs(ping_every));
                if !write_out!(wbuf) {
                    break 'main;
                }
            }
            out = rx.recv(), if !s.close_sent => {
                let Some(first) = out else { break 'main };
                let mut sent_len = 0usize;
                let mut next = Some(first);
                let mut n = 0;
                while let Some(o) = next.take() {
                    match o {
                        WsOut::Msg(m) => {
                            sent_len += data_len(&m);
                            append(&mut wbuf, &m, &mut deflater);
                        }
                        WsOut::Close(c, r) => {
                            uws::write_close(&mut wbuf, c, r.as_bytes());
                            s.close_sent = true;
                            give_up.as_mut().reset(Instant::now() + CLOSE_WAIT);
                            break;
                        }
                    }
                    n += 1;
                    if n < 512 {
                        next = rx.try_recv().ok();
                    }
                }
                let ok = write_out!(wbuf);
                let left = pending.fetch_sub(sent_len, Ordering::Relaxed).saturating_sub(sent_len);
                if !ok {
                    break 'main;
                }
                // Non-closing backpressure: tell JS when the backlog has cleared so it can resume sending.
                if over.load(Ordering::Relaxed) && left < drain_limit / 2 {
                    over.store(false, Ordering::Relaxed);
                    sh.push(lane, QItem::Event(ws_simple_event(12, id)));
                }
            }
            n = async {
                // A paused socket is not read at all, so TCP flow control pushes back on the peer.
                while gate.paused.load(Ordering::Acquire) {
                    gate.wake.notified().await;
                }
                // Read into the thread's shared buffer; it is only borrowed during a poll, and the bytes are parsed
                // before anything else on this thread can run.
                std::future::poll_fn(|cx| {
                    RBUF.with(|b| {
                        let mut b = b.borrow_mut();
                        let mut rb = ReadBuf::new(&mut b[pre..pre + READ_CHUNK]);
                        match std::pin::Pin::new(&mut io).poll_read(cx, &mut rb) {
                            std::task::Poll::Ready(Ok(())) => std::task::Poll::Ready(rb.filled().len()),
                            std::task::Poll::Ready(Err(_)) => std::task::Poll::Ready(0),
                            std::task::Poll::Pending => std::task::Poll::Pending,
                        }
                    })
                })
                .await
            } => {
                if n == 0 {
                    break 'main; // the peer went away without a close frame: 1006
                }
                // A pause may have arrived while we waited for this read: hold the data back until it ends.
                while gate.paused.load(Ordering::Acquire) {
                    gate.wake.notified().await;
                }
                RBUF.with(|b| {
                    let mut b = b.borrow_mut();
                    parser.consume(&mut b, pre, n, &mut s);
                });
                sh.push_events(lane, &mut s.events, &mut s.event_count);
            }
        }
    }

    sh.ws_unregister(id);
    let reason = &reason[..reason.len().min(123)];
    let mut ev = Vec::with_capacity(9 + reason.len());
    ev.push(4);
    ev.extend_from_slice(&id.to_le_bytes());
    ev.extend_from_slice(&code.to_le_bytes());
    ev.extend_from_slice(&(reason.len() as u16).to_le_bytes());
    ev.extend_from_slice(reason);
    sh.push(lane, QItem::Event(ev));
    // Let a TLS close_notify (or a FIN) go out; never wait long for it.
    let _ = tokio::time::timeout(Duration::from_millis(200), io.shutdown()).await;
}
