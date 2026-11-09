//! Hand-rolled WebSocket client: handshake, zero-copy frame parser, and the
//! ws-echo / ws-fanout workloads.

use crate::{log_err, Clock, Stats};
use std::io::{self, ErrorKind};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout_at, Instant as TInstant};

const MASK: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];
const MAX_FRAME: u64 = 1 << 30;

fn proto(msg: &str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, msg.to_string())
}

/// Build one complete masked client TEXT frame (FIN set).
pub fn build_text_frame(payload: &[u8]) -> Vec<u8> {
    let l = payload.len();
    let mut f = Vec::with_capacity(l + 14);
    f.push(0x81);
    if l < 126 {
        f.push(0x80 | l as u8);
    } else if l <= 65535 {
        f.push(0x80 | 126);
        f.extend_from_slice(&(l as u16).to_be_bytes());
    } else {
        f.push(0x80 | 127);
        f.extend_from_slice(&(l as u64).to_be_bytes());
    }
    f.extend_from_slice(&MASK);
    f.extend(payload.iter().enumerate().map(|(i, b)| b ^ MASK[i & 3]));
    f
}

pub fn make_payload(len: usize) -> Vec<u8> {
    (0..len).map(|i| b'a' + (i % 26) as u8).collect()
}

#[derive(Clone, Copy, Debug)]
pub struct Msg {
    pub len: usize,
    #[allow(dead_code)]
    pub binary: bool,
}

/// Receive buffer + incremental frame parser. Parsing never copies payloads
/// of unfragmented messages; `payload()` borrows straight from the buffer.
pub struct FrameBuf {
    buf: Vec<u8>,
    start: usize,
    end: usize,
    /// Total size of the incomplete frame at `start` (0 = header not complete yet).
    need: usize,
    frag: Vec<u8>,
    frag_active: bool,
    frag_binary: bool,
    cur: (usize, usize),
    cur_frag: bool,
    /// Masked pong frames to flush before the next read.
    pub pongs: Vec<u8>,
}

impl FrameBuf {
    pub fn new(cap: usize) -> Self {
        FrameBuf {
            buf: vec![0u8; cap.max(64)],
            start: 0,
            end: 0,
            need: 0,
            frag: Vec::new(),
            frag_active: false,
            frag_binary: false,
            cur: (0, 0),
            cur_frag: false,
            pongs: Vec::new(),
        }
    }

    /// Unconsumed bytes.
    pub fn pending(&self) -> &[u8] {
        &self.buf[self.start..self.end]
    }

    pub fn consume(&mut self, n: usize) {
        self.start += n;
    }

    /// Free space to read into. Compacts / grows as required.
    pub fn spare(&mut self) -> &mut [u8] {
        if self.start == self.end {
            self.start = 0;
            self.end = 0;
        }
        let need_total = if self.need > 0 { self.need } else { 14 };
        if self.start > 0
            && (self.buf.len() - self.end < self.buf.len() / 4
                || self.start + need_total > self.buf.len())
        {
            self.buf.copy_within(self.start..self.end, 0);
            self.end -= self.start;
            self.start = 0;
        }
        if need_total > self.buf.len() {
            self.buf.resize(need_total.next_power_of_two(), 0);
        }
        if self.end == self.buf.len() {
            let n = self.buf.len() * 2;
            self.buf.resize(n, 0);
        }
        &mut self.buf[self.end..]
    }

    pub fn commit(&mut self, n: usize) {
        self.end += n;
    }

    pub fn payload(&self) -> &[u8] {
        if self.cur_frag {
            &self.frag
        } else {
            &self.buf[self.cur.0..self.cur.1]
        }
    }

    /// Parse the next complete data message out of the buffer, if any.
    /// Handles fragmentation, ping (queues a pong), pong, and close.
    pub fn next_msg(&mut self) -> io::Result<Option<Msg>> {
        loop {
            let avail = self.end - self.start;
            if avail < 2 {
                self.need = 0;
                return Ok(None);
            }
            let b = &self.buf[self.start..self.end];
            let (b0, b1) = (b[0], b[1]);
            if b0 & 0x70 != 0 {
                return Err(proto("reserved bits set in server frame"));
            }
            if b1 & 0x80 != 0 {
                return Err(proto("server frame is masked"));
            }
            let fin = b0 & 0x80 != 0;
            let op = b0 & 0x0f;
            let l7 = (b1 & 0x7f) as usize;
            let (hdr, plen) = match l7 {
                126 => {
                    if avail < 4 {
                        self.need = 0;
                        return Ok(None);
                    }
                    (4usize, u16::from_be_bytes([b[2], b[3]]) as usize)
                }
                127 => {
                    if avail < 10 {
                        self.need = 0;
                        return Ok(None);
                    }
                    let l = u64::from_be_bytes(b[2..10].try_into().unwrap());
                    if l > MAX_FRAME {
                        return Err(proto("frame too large"));
                    }
                    (10usize, l as usize)
                }
                n => (2usize, n),
            };
            let total = hdr + plen;
            if avail < total {
                self.need = total;
                return Ok(None);
            }
            self.need = 0;
            let ps = self.start + hdr;
            let pe = ps + plen;
            self.start += total;
            match op {
                0x8 => {
                    return Err(io::Error::new(
                        ErrorKind::ConnectionAborted,
                        "server sent close frame",
                    ))
                }
                0x9 => {
                    if plen > 125 || !fin {
                        return Err(proto("bad ping frame"));
                    }
                    self.pongs.push(0x8A);
                    self.pongs.push(0x80 | plen as u8);
                    self.pongs.extend_from_slice(&MASK);
                    let (buf, pongs) = (&self.buf, &mut self.pongs);
                    pongs.extend(buf[ps..pe].iter().enumerate().map(|(i, b)| b ^ MASK[i & 3]));
                }
                0xA => {}
                0x1 | 0x2 => {
                    if self.frag_active {
                        return Err(proto("new data frame during fragmented message"));
                    }
                    if fin {
                        self.cur = (ps, pe);
                        self.cur_frag = false;
                        return Ok(Some(Msg { len: plen, binary: op == 2 }));
                    }
                    self.frag.clear();
                    self.frag.extend_from_slice(&self.buf[ps..pe]);
                    self.frag_active = true;
                    self.frag_binary = op == 2;
                }
                0x0 => {
                    if !self.frag_active {
                        return Err(proto("unexpected continuation frame"));
                    }
                    self.frag.extend_from_slice(&self.buf[ps..pe]);
                    if fin {
                        self.frag_active = false;
                        self.cur_frag = true;
                        return Ok(Some(Msg { len: self.frag.len(), binary: self.frag_binary }));
                    }
                }
                _ => return Err(proto("unknown opcode")),
            }
        }
    }
}

pub struct WsConn {
    pub s: TcpStream,
    pub fb: FrameBuf,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

impl WsConn {
    pub async fn connect(addr: SocketAddr, authority: &str, path: &str) -> io::Result<WsConn> {
        let mut s = TcpStream::connect(addr).await?;
        s.set_nodelay(true)?;
        // WS_EXTRA_HEADER="Name: value" adds a header to the handshake (e.g. a bearer token).
        let extra = std::env::var("WS_EXTRA_HEADER").map(|h| format!("{h}\r\n")).unwrap_or_default();
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{extra}\r\n"
        );
        s.write_all(req.as_bytes()).await?;
        let mut fb = FrameBuf::new(16 * 1024);
        loop {
            let n = s.read(fb.spare()).await?;
            if n == 0 {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "connection closed during websocket handshake",
                ));
            }
            fb.commit(n);
            if let Some(pos) = find(fb.pending(), b"\r\n\r\n") {
                let head = &fb.pending()[..pos];
                let line_end = find(head, b"\r\n").unwrap_or(head.len());
                let line = String::from_utf8_lossy(&head[..line_end]).into_owned();
                if !(line.starts_with("HTTP/1.1 101") || line.starts_with("HTTP/1.0 101")) {
                    return Err(proto(&format!("handshake failed: {line}")));
                }
                fb.consume(pos + 4);
                break;
            }
            if fb.pending().len() > 16 * 1024 {
                return Err(proto("handshake response too large"));
            }
        }
        Ok(WsConn { s, fb })
    }

    /// Flush queued pongs, then read once from the socket into the buffer.
    pub async fn fill(&mut self) -> io::Result<()> {
        if !self.fb.pongs.is_empty() {
            let p = std::mem::take(&mut self.fb.pongs);
            self.s.write_all(&p).await?;
            self.fb.pongs = p;
            self.fb.pongs.clear();
        }
        let n = self.s.read(self.fb.spare()).await?;
        if n == 0 {
            return Err(io::Error::new(ErrorKind::UnexpectedEof, "server closed connection"));
        }
        self.fb.commit(n);
        Ok(())
    }

    pub async fn read_msg(&mut self) -> io::Result<Msg> {
        loop {
            if let Some(m) = self.fb.next_msg()? {
                return Ok(m);
            }
            self.fill().await?;
        }
    }
}

#[inline]
fn sat_ns(d: std::time::Duration) -> u32 {
    d.as_nanos().min(u32::MAX as u128) as u32
}

/// Request/response loop shared by ws-echo (every conn) and the ws-fanout
/// publisher (conn #0). Returns Ok when the measurement window has ended.
async fn rtt_loop(
    c: &mut WsConn,
    frame: &[u8],
    payload: &[u8],
    clk: Clock,
    st: &mut Stats,
    publisher: bool,
) -> io::Result<()> {
    // WS_PIPELINE=k keeps k messages in flight per connection (default 1: strict request/response). A client that
    // batches calls, like Forge RPC's, behaves this way, and it is what it takes to saturate a server.
    static PIPE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let k = *PIPE.get_or_init(|| std::env::var("WS_PIPELINE").ok().and_then(|v| v.parse().ok()).filter(|k: &usize| *k >= 1).unwrap_or(1));
    static LENIENT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let lenient = *LENIENT.get_or_init(|| std::env::var_os("WS_LENIENT").is_some());
    let burst: Vec<u8> = if k == 1 { Vec::new() } else { frame.repeat(k) };
    loop {
        let t0 = Instant::now();
        if t0 >= clk.measure_end {
            return Ok(());
        }
        c.s.write_all(if k == 1 { frame } else { &burst }).await?;
        for _ in 0..k {
            let m = c.read_msg().await?;
            let t1 = Instant::now();
            if (!lenient && (m.len != payload.len() || c.fb.payload() != payload)) || m.len == 0 {
                return Err(proto("received message does not match the one sent"));
            }
            if clk.in_window(t1) {
                st.msgs += 1;
                if publisher {
                    st.pubs += 1;
                }
                st.lat.push(sat_ns(t1 - t0));
            }
        }
    }
}

pub async fn rtt_task(
    mut c: WsConn,
    idx: usize,
    frame: Arc<Vec<u8>>,
    payload: Arc<Vec<u8>>,
    clk: Clock,
    publisher: bool,
) -> Stats {
    let mut st = Stats::default();
    st.lat.reserve(1 << 14);
    let r = timeout_at(
        TInstant::from_std(clk.hard_end),
        rtt_loop(&mut c, &frame, &payload, clk, &mut st, publisher),
    )
    .await;
    match r {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            st.errors += 1;
            log_err(format!("conn {idx}: {e}"));
        }
        Err(_) => {
            st.errors += 1;
            log_err(format!("conn {idx}: no reply within grace period after the window ended"));
        }
    }
    st
}

/// Passive subscriber: just read and count messages (attributed per read batch).
async fn reader_loop(c: &mut WsConn, clk: Clock, st: &mut Stats) -> io::Result<()> {
    loop {
        let mut cnt = 0u64;
        while c.fb.next_msg()?.is_some() {
            cnt += 1;
        }
        let now = Instant::now();
        if cnt > 0 && clk.in_window(now) {
            st.msgs += cnt;
        }
        if now >= clk.measure_end {
            return Ok(());
        }
        match timeout_at(TInstant::from_std(clk.measure_end), c.fill()).await {
            Err(_) => return Ok(()),
            Ok(r) => r?,
        }
    }
}

pub async fn reader_task(mut c: WsConn, idx: usize, clk: Clock) -> Stats {
    let mut st = Stats::default();
    if let Err(e) = reader_loop(&mut c, clk, &mut st).await {
        st.errors += 1;
        log_err(format!("conn {idx}: {e}"));
    }
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srv_frame(op: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![(if fin { 0x80 } else { 0 }) | op];
        let l = payload.len();
        if l < 126 {
            f.push(l as u8);
        } else if l <= 65535 {
            f.push(126);
            f.extend_from_slice(&(l as u16).to_be_bytes());
        } else {
            f.push(127);
            f.extend_from_slice(&(l as u64).to_be_bytes());
        }
        f.extend_from_slice(payload);
        f
    }

    /// Feed `bytes` in `chunk`-sized pieces, collecting every message payload.
    fn run(bytes: &[u8], chunk: usize) -> io::Result<Vec<Vec<u8>>> {
        let mut fb = FrameBuf::new(64);
        let mut out = Vec::new();
        for piece in bytes.chunks(chunk) {
            let mut off = 0;
            while off < piece.len() {
                let sp = fb.spare();
                let n = sp.len().min(piece.len() - off);
                sp[..n].copy_from_slice(&piece[off..off + n]);
                fb.commit(n);
                off += n;
                while let Some(m) = fb.next_msg()? {
                    assert_eq!(m.len, fb.payload().len());
                    out.push(fb.payload().to_vec());
                }
            }
        }
        Ok(out)
    }

    #[test]
    fn frames_split_every_way() {
        let big: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
        let mid: Vec<u8> = (0..300u32).map(|i| (i % 7) as u8).collect();
        let mut stream = Vec::new();
        stream.extend(srv_frame(1, true, b"hello"));
        stream.extend(srv_frame(2, true, &mid));
        stream.extend(srv_frame(1, true, b""));
        stream.extend(srv_frame(1, true, &big));
        // fragmented message with a ping in the middle
        stream.extend(srv_frame(1, false, b"abc"));
        stream.extend(srv_frame(9, true, b"pp"));
        stream.extend(srv_frame(0, false, b"def"));
        stream.extend(srv_frame(0, true, b"ghi"));
        stream.extend(srv_frame(10, true, b"")); // pong
        stream.extend(srv_frame(1, true, b"tail"));
        for chunk in [1usize, 2, 3, 7, 64, 1000, 100_000] {
            let msgs = run(&stream, chunk).unwrap();
            assert_eq!(msgs.len(), 6, "chunk={chunk}");
            assert_eq!(msgs[0], b"hello");
            assert_eq!(msgs[1], mid);
            assert_eq!(msgs[2], b"");
            assert_eq!(msgs[3], big);
            assert_eq!(msgs[4], b"abcdefghi");
            assert_eq!(msgs[5], b"tail");
        }
    }

    #[test]
    fn ping_queues_masked_pong_and_close_errors() {
        let mut fb = FrameBuf::new(64);
        let f = srv_frame(9, true, b"xy");
        fb.spare()[..f.len()].copy_from_slice(&f);
        fb.commit(f.len());
        assert!(fb.next_msg().unwrap().is_none());
        assert_eq!(fb.pongs[0], 0x8A);
        assert_eq!(fb.pongs[1], 0x82);
        let c = srv_frame(8, true, &[3, 232]);
        assert!(run(&c, 1).is_err());
    }

    #[test]
    fn masked_server_frame_is_error() {
        let mut f = srv_frame(1, true, b"hi");
        f[1] |= 0x80;
        assert!(run(&f, 100).is_err());
    }

    #[test]
    fn client_frame_roundtrip_shape() {
        let p = make_payload(16);
        let f = build_text_frame(&p);
        assert_eq!(f.len(), 2 + 4 + 16);
        assert_eq!(f[0], 0x81);
        assert_eq!(f[1], 0x80 | 16);
        let unmasked: Vec<u8> = f[6..].iter().enumerate().map(|(i, b)| b ^ MASK[i & 3]).collect();
        assert_eq!(unmasked, p);
        assert_eq!(build_text_frame(&make_payload(200))[1], 0x80 | 126);
        assert_eq!(build_text_frame(&make_payload(70_000))[1], 0x80 | 127);
    }
}
