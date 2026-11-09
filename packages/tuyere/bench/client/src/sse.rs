//! Hand-rolled HTTP/1.1 SSE client: response head parser, chunked decoder,
//! exact "\n\n" event counter, and the sse-burst workload.

use crate::{log_err, Clock, Stats};
use std::io::{self, ErrorKind};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout_at, Instant as TInstant};

/// No bytes for this long while the window is open counts as a stall error.
const STALL: Duration = Duration::from_secs(5);

fn bad(msg: impl Into<String>) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, msg.into())
}

/// Counts non-overlapping "\n\n" terminators across arbitrary splits.
#[derive(Default)]
pub struct EventCounter {
    prev_nl: bool,
    pub count: u64,
}

impl EventCounter {
    #[inline]
    pub fn feed(&mut self, data: &[u8]) {
        let mut prev = self.prev_nl;
        let mut c = 0u64;
        for &b in data {
            if b == b'\n' {
                if prev {
                    c += 1;
                    prev = false;
                } else {
                    prev = true;
                }
            } else {
                prev = false;
            }
        }
        self.prev_nl = prev;
        self.count += c;
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum CS {
    Size,
    Ext,
    SizeLf,
    Data,
    DataCr,
    DataLf,
    TrailerStart,
    TrailerLine,
    TrailerLf,
    EndLf,
    Done,
}

/// Incremental HTTP/1.1 chunked transfer-encoding decoder.
pub struct ChunkDecoder {
    st: CS,
    size: u64,
    digits: bool,
    remaining: u64,
}

impl ChunkDecoder {
    pub fn new() -> Self {
        ChunkDecoder { st: CS::Size, size: 0, digits: false, remaining: 0 }
    }

    pub fn done(&self) -> bool {
        self.st == CS::Done
    }

    /// Decode as much of `data` as belongs to the chunked body; body bytes go
    /// to `sink`. Returns bytes consumed (< data.len() only once Done).
    pub fn feed(&mut self, data: &[u8], mut sink: impl FnMut(&[u8])) -> io::Result<usize> {
        let mut i = 0;
        while i < data.len() {
            match self.st {
                CS::Done => break,
                CS::Data => {
                    let take = (data.len() - i).min(self.remaining.min(usize::MAX as u64) as usize);
                    sink(&data[i..i + take]);
                    i += take;
                    self.remaining -= take as u64;
                    if self.remaining == 0 {
                        self.st = CS::DataCr;
                    }
                }
                st => {
                    let b = data[i];
                    i += 1;
                    match st {
                        CS::Size => match b {
                            b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F' => {
                                let d = (b as char).to_digit(16).unwrap() as u64;
                                if self.size > (1 << 40) {
                                    return Err(bad("chunk size too large"));
                                }
                                self.size = self.size * 16 + d;
                                self.digits = true;
                            }
                            b';' if self.digits => self.st = CS::Ext,
                            b'\r' if self.digits => self.st = CS::SizeLf,
                            _ => return Err(bad("bad chunk size line")),
                        },
                        CS::Ext => {
                            if b == b'\r' {
                                self.st = CS::SizeLf;
                            }
                        }
                        CS::SizeLf => {
                            if b != b'\n' {
                                return Err(bad("bad chunk size line ending"));
                            }
                            if self.size == 0 {
                                self.st = CS::TrailerStart;
                            } else {
                                self.remaining = self.size;
                                self.st = CS::Data;
                            }
                        }
                        CS::DataCr => {
                            if b != b'\r' {
                                return Err(bad("missing CR after chunk data"));
                            }
                            self.st = CS::DataLf;
                        }
                        CS::DataLf => {
                            if b != b'\n' {
                                return Err(bad("missing LF after chunk data"));
                            }
                            self.st = CS::Size;
                            self.size = 0;
                            self.digits = false;
                        }
                        CS::TrailerStart => {
                            self.st = if b == b'\r' { CS::EndLf } else { CS::TrailerLine };
                        }
                        CS::TrailerLine => {
                            if b == b'\r' {
                                self.st = CS::TrailerLf;
                            }
                        }
                        CS::TrailerLf => {
                            if b != b'\n' {
                                return Err(bad("bad trailer line ending"));
                            }
                            self.st = CS::TrailerStart;
                        }
                        CS::EndLf => {
                            if b != b'\n' {
                                return Err(bad("bad final CRLF"));
                            }
                            self.st = CS::Done;
                        }
                        CS::Data | CS::Done => unreachable!(),
                    }
                }
            }
        }
        Ok(i)
    }
}

#[derive(Debug)]
struct Head {
    status: u16,
    chunked: bool,
    content_length: Option<u64>,
    close: bool,
    len: usize,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn parse_head(buf: &[u8]) -> io::Result<Option<Head>> {
    let Some(pos) = find(buf, b"\r\n\r\n") else { return Ok(None) };
    let text = String::from_utf8_lossy(&buf[..pos]);
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or("");
    let status: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| bad(format!("bad status line {status_line:?}")))?;
    let mut h = Head {
        status,
        chunked: false,
        content_length: None,
        close: version == "HTTP/1.0",
        len: pos + 4,
    };
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if k.eq_ignore_ascii_case("transfer-encoding") {
            if v.to_ascii_lowercase().contains("chunked") {
                h.chunked = true;
            }
        } else if k.eq_ignore_ascii_case("content-length") {
            h.content_length = v.parse().ok();
        } else if k.eq_ignore_ascii_case("connection") && v.to_ascii_lowercase().contains("close") {
            h.close = true;
        }
    }
    Ok(Some(h))
}

enum Body {
    Chunked(ChunkDecoder),
    Length(u64),
    UntilClose,
}

impl Body {
    /// Feed decoded-body candidate bytes; returns (done, extra_bytes_after_end).
    fn feed(&mut self, data: &[u8], ev: &mut EventCounter) -> io::Result<(bool, bool)> {
        match self {
            Body::Chunked(d) => {
                let used = d.feed(data, |b| ev.feed(b))?;
                Ok((d.done(), d.done() && used < data.len()))
            }
            Body::Length(rem) => {
                let take = (*rem).min(data.len() as u64) as usize;
                ev.feed(&data[..take]);
                *rem -= take as u64;
                Ok((*rem == 0, *rem == 0 && take < data.len()))
            }
            Body::UntilClose => {
                ev.feed(data);
                Ok((false, false))
            }
        }
    }
}

enum Outcome {
    /// Stream fully read. `events` is the exact count of "\n\n" terminators.
    Complete { events: u64, reusable: bool },
    /// Measurement window ended mid-stream (not an error).
    Deadline,
}

struct StreamErr {
    err: io::Error,
    /// True if not a single response byte was received (stale keep-alive suspect).
    no_bytes: bool,
}

async fn run_stream(
    s: &mut TcpStream,
    buf: &mut [u8],
    req: &[u8],
    clk: Clock,
    st: &mut Stats,
    close_after: bool,
) -> Result<Outcome, StreamErr> {
    let t_req = Instant::now();
    let mut got_any = false;
    macro_rules! fail {
        ($e:expr) => {
            return Err(StreamErr { err: $e, no_bytes: !got_any })
        };
    }
    if let Err(e) = s.write_all(req).await {
        fail!(e);
    }
    // read wrapper: Some(n) data, None = window ended (not an error unless the
    // server had been silent for >= 2s, i.e. the stream was stalled)
    let mut last_rx = t_req;
    macro_rules! read_some {
        ($dst:expr) => {{
            let dl = (Instant::now() + STALL).min(clk.measure_end);
            match timeout_at(TInstant::from_std(dl), s.read($dst)).await {
                Ok(Ok(n)) => {
                    last_rx = Instant::now();
                    Some(n)
                }
                Ok(Err(e)) => fail!(e),
                Err(_) => {
                    let now = Instant::now();
                    if now.duration_since(last_rx) >= Duration::from_secs(2) {
                        fail!(io::Error::new(
                            ErrorKind::TimedOut,
                            format!("stalled: no data for {:.1?}", now.duration_since(last_rx))
                        ))
                    } else if now >= clk.measure_end {
                        None
                    } else {
                        // woke early (should not happen); just try again
                        continue;
                    }
                }
            }
        }};
    }
    macro_rules! account {
        ($n:expr, $ev0:expr, $ev:expr) => {{
            let now = Instant::now();
            if clk.in_window(now) {
                st.bytes += $n as u64;
                st.events += $ev.count - $ev0;
            }
            now
        }};
    }

    // --- response head ---
    let mut end = 0usize;
    let head = loop {
        if end == buf.len() {
            fail!(bad("response head too large"));
        }
        let Some(n) = read_some!(&mut buf[end..]) else {
            return Ok(Outcome::Deadline);
        };
        if n == 0 {
            fail!(io::Error::new(ErrorKind::UnexpectedEof, "connection closed before response head"));
        }
        got_any = true;
        end += n;
        if clk.in_window(Instant::now()) {
            st.bytes += n as u64;
        }
        match parse_head(&buf[..end]) {
            Ok(Some(h)) => break h,
            Ok(None) => {}
            Err(e) => fail!(e),
        }
    };
    if head.status != 200 {
        fail!(bad(format!("unexpected HTTP status {}", head.status)));
    }
    let mut body = if head.chunked {
        Body::Chunked(ChunkDecoder::new())
    } else if let Some(cl) = head.content_length {
        Body::Length(cl)
    } else {
        Body::UntilClose
    };
    let until_close = matches!(body, Body::UntilClose);
    let mut ev = EventCounter::default();
    let mut extra = false;

    // body bytes that arrived together with the head
    let ev0 = 0;
    let (mut done, ex) = match body.feed(&buf[head.len..end], &mut ev) {
        Ok(r) => r,
        Err(e) => fail!(e),
    };
    extra |= ex;
    if clk.in_window(Instant::now()) {
        st.events += ev.count - ev0;
    }

    // --- body ---
    while !done {
        let Some(n) = read_some!(&mut buf[..]) else {
            return Ok(Outcome::Deadline);
        };
        if n == 0 {
            if until_close {
                break;
            }
            fail!(io::Error::new(ErrorKind::UnexpectedEof, "connection closed mid-stream"));
        }
        let ev0 = ev.count;
        let (d, ex) = match body.feed(&buf[..n], &mut ev) {
            Ok(r) => r,
            Err(e) => fail!(e),
        };
        done = d;
        extra |= ex;
        account!(n, ev0, ev);
    }
    Ok(Outcome::Complete {
        events: ev.count,
        reusable: !close_after && !head.close && !until_close && !extra,
    })
}

pub struct SseCfg {
    pub addr: SocketAddr,
    pub request: Vec<u8>,
    pub expected: Option<u64>,
    pub keepalive: bool,
    pub buf_size: usize,
}

async fn dial(addr: SocketAddr) -> io::Result<TcpStream> {
    let s = TcpStream::connect(addr).await?;
    s.set_nodelay(true)?;
    Ok(s)
}

pub async fn open(addr: SocketAddr) -> io::Result<TcpStream> {
    dial(addr).await
}

pub async fn sse_task(first: TcpStream, idx: usize, cfg: Arc<SseCfg>, clk: Clock) -> Stats {
    let mut st = Stats::default();
    let mut buf = vec![0u8; cfg.buf_size];
    let mut conn: Option<TcpStream> = Some(first);
    let mut served = 0u32; // streams already served by `conn`
    loop {
        if Instant::now() >= clk.measure_end {
            break;
        }
        let mut s = match conn.take() {
            Some(s) => s,
            None => match dial(cfg.addr).await {
                Ok(s) => {
                    served = 0;
                    s
                }
                Err(e) => {
                    st.errors += 1;
                    log_err(format!("conn {idx}: connect: {e}"));
                    sleep(Duration::from_millis(10)).await;
                    continue;
                }
            },
        };
        let res = run_stream(&mut s, &mut buf, &cfg.request, clk, &mut st, !cfg.keepalive).await;
        match res {
            Ok(Outcome::Complete { events, reusable }) => {
                if clk.in_window(Instant::now()) {
                    st.streams += 1;
                }
                if let Some(n) = cfg.expected {
                    if events != n {
                        st.errors += 1;
                        log_err(format!("conn {idx}: stream had {events} events, expected {n}"));
                    }
                }
                if reusable && cfg.keepalive {
                    served += 1;
                    conn = Some(s);
                }
            }
            Ok(Outcome::Deadline) => break,
            Err(e) => {
                if e.no_bytes && served > 0 {
                    // stale keep-alive connection closed by the server: retry on a fresh one
                    continue;
                }
                st.errors += 1;
                log_err(format!("conn {idx}: {}", e.err));
                sleep(Duration::from_millis(1)).await;
            }
        }
    }
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunked_stream(events: usize, per_chunk: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let ev = b"data: x\n\n";
        let mut i = 0;
        while i < events {
            let k = per_chunk.min(events - i);
            let body: Vec<u8> = ev.iter().cycle().take(ev.len() * k).copied().collect();
            out.extend(format!("{:x}\r\n", body.len()).as_bytes());
            out.extend(&body);
            out.extend(b"\r\n");
            i += k;
        }
        out.extend(b"0\r\n\r\n");
        out
    }

    #[test]
    fn counts_events_across_every_split() {
        for per_chunk in [1usize, 2, 3, 100] {
            let s = chunked_stream(1000, per_chunk);
            for piece in [1usize, 2, 3, 5, 8, 9, 10, 17, 1024, 1 << 20] {
                let mut d = ChunkDecoder::new();
                let mut ev = EventCounter::default();
                let mut consumed = 0;
                for p in s.chunks(piece) {
                    consumed += d.feed(p, |b| ev.feed(b)).unwrap();
                }
                assert!(d.done());
                assert_eq!(consumed, s.len());
                assert_eq!(ev.count, 1000, "per_chunk={per_chunk} piece={piece}");
            }
        }
    }

    #[test]
    fn event_counter_boundary_state() {
        let mut ev = EventCounter::default();
        ev.feed(b"data: a\n");
        assert_eq!(ev.count, 0);
        ev.feed(b"\ndata: b\n");
        assert_eq!(ev.count, 1);
        ev.feed(b"\n");
        assert_eq!(ev.count, 2);
        ev.feed(b"\n\n\n\n");
        assert_eq!(ev.count, 4); // non-overlapping pairs
    }

    #[test]
    fn chunk_extensions_and_trailers() {
        let s = b"4;foo=bar\r\ndata\r\n3\r\n: x\r\n0\r\nX-T: 1\r\n\r\n";
        let mut d = ChunkDecoder::new();
        let mut got = Vec::new();
        let n = d.feed(s, |b| got.extend_from_slice(b)).unwrap();
        assert!(d.done());
        assert_eq!(n, s.len());
        assert_eq!(got, b"data: x");
    }

    #[test]
    fn trailing_bytes_not_consumed() {
        let mut s = chunked_stream(2, 2);
        let len = s.len();
        s.extend(b"HTTP/1.1 junk");
        let mut d = ChunkDecoder::new();
        let n = d.feed(&s, |_| {}).unwrap();
        assert_eq!(n, len);
    }

    #[test]
    fn bad_chunk_is_error() {
        let mut d = ChunkDecoder::new();
        assert!(d.feed(b"zz\r\n", |_| {}).is_err());
        let mut d = ChunkDecoder::new();
        assert!(d.feed(b"2\r\nabXX", |_| {}).is_err());
    }

    #[test]
    fn head_parse() {
        let h = parse_head(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n5\r\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(h.status, 200);
        assert!(h.chunked && !h.close);
        assert_eq!(h.len, b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n".len());
        assert!(parse_head(b"HTTP/1.1 200 OK\r\nA: b\r\n").unwrap().is_none());
        let h = parse_head(b"HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\n").unwrap().unwrap();
        assert_eq!(h.content_length, Some(7));
        assert!(h.close);
    }
}
