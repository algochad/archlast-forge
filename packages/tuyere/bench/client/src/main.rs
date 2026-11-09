//! Load-test client for WebSocket and SSE servers (what `oha` cannot do).
//!
//! client <mode> [--url URL] [--conns N] [--secs T] [--payload BYTES]
//!               [--threads K] [--warmup S] [--no-keepalive]
//! modes: ws-echo | ws-fanout | sse-burst
//!
//! Exactly one JSON line goes to stdout; everything else goes to stderr.

mod sse;
mod url;
mod ws;

use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

const OPEN_TIMEOUT: Duration = Duration::from_secs(6);
const GRACE: Duration = Duration::from_secs(2);
const USAGE: &str = "usage: client <ws-echo|ws-fanout|sse-burst> [--url URL] [--conns N] [--secs T] \
[--payload BYTES] [--threads K] [--warmup S] [--no-keepalive]\n\
defaults: conns 50, secs 8, payload 16, threads 4, warmup 1; \
url ws://127.0.0.1:3000/ws (ws modes) or http://127.0.0.1:3000/sse?n=1000 (sse-burst)";

#[derive(Clone, Copy)]
pub struct Clock {
    pub warmup_end: Instant,
    pub measure_end: Instant,
    pub hard_end: Instant,
}

impl Clock {
    #[inline]
    pub fn in_window(&self, t: Instant) -> bool {
        t >= self.warmup_end && t < self.measure_end
    }
}

#[derive(Default)]
pub struct Stats {
    /// ws-echo: completed round trips; ws-fanout: messages received (all conns).
    pub msgs: u64,
    /// ws-fanout: publisher round trips.
    pub pubs: u64,
    pub events: u64,
    pub streams: u64,
    pub bytes: u64,
    pub errors: u64,
    /// Latencies in nanoseconds (saturating u32).
    pub lat: Vec<u32>,
}

static ERR_LOGGED: AtomicUsize = AtomicUsize::new(0);

/// Log the first few distinct-ish errors to stderr.
pub fn log_err(msg: String) {
    if ERR_LOGGED.fetch_add(1, Ordering::Relaxed) < 10 {
        eprintln!("error: {msg}");
    }
}

struct Cfg {
    mode: String,
    url: String,
    conns: usize,
    secs: f64,
    payload: usize,
    threads: usize,
    warmup: f64,
    keepalive: bool,
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2);
}

fn parse_args() -> Cfg {
    let mut args = std::env::args().skip(1);
    let mode = match args.next() {
        Some(m) if m == "-h" || m == "--help" => {
            eprintln!("{USAGE}");
            std::process::exit(0);
        }
        Some(m) => m,
        None => die(USAGE),
    };
    if !["ws-echo", "ws-fanout", "sse-burst"].contains(&mode.as_str()) {
        die(&format!("unknown mode {mode:?}\n{USAGE}"));
    }
    let mut c = Cfg {
        url: if mode == "sse-burst" {
            "http://127.0.0.1:3000/sse?n=1000".into()
        } else {
            "ws://127.0.0.1:3000/ws".into()
        },
        mode,
        conns: 50,
        secs: 8.0,
        payload: 16,
        threads: 4,
        warmup: 1.0,
        keepalive: true,
    };
    let rest: Vec<String> = args.collect();
    let mut i = 0;
    while i < rest.len() {
        let (flag, inline) = match rest[i].split_once('=') {
            Some((f, v)) => (f.to_string(), Some(v.to_string())),
            None => (rest[i].clone(), None),
        };
        i += 1;
        if flag == "--no-keepalive" {
            c.keepalive = false;
            continue;
        }
        if flag == "-h" || flag == "--help" {
            eprintln!("{USAGE}");
            std::process::exit(0);
        }
        let val = match inline {
            Some(v) => v,
            None => {
                let v = rest.get(i).cloned().unwrap_or_else(|| die(&format!("{flag} needs a value")));
                i += 1;
                v
            }
        };
        let num = |name: &str| -> f64 {
            val.parse::<f64>()
                .ok()
                .filter(|x| x.is_finite() && *x >= 0.0)
                .unwrap_or_else(|| die(&format!("bad value for {name}: {val:?}")))
        };
        match flag.as_str() {
            "--url" => c.url = val.clone(),
            "--conns" => c.conns = num("--conns") as usize,
            "--secs" => c.secs = num("--secs"),
            "--payload" => c.payload = num("--payload") as usize,
            "--threads" => c.threads = num("--threads") as usize,
            "--warmup" => c.warmup = num("--warmup"),
            other => die(&format!("unknown flag {other:?}\n{USAGE}")),
        }
    }
    if c.conns == 0 || c.threads == 0 || c.secs <= 0.0 {
        die("--conns, --threads must be >= 1 and --secs > 0");
    }
    c
}

fn raise_nofile(conns: usize) {
    unsafe {
        let mut rl = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) == 0 {
            if rl.rlim_cur < rl.rlim_max {
                rl.rlim_cur = rl.rlim_max;
                libc::setrlimit(libc::RLIMIT_NOFILE, &rl);
                libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl);
            }
            if (rl.rlim_cur as usize) < conns + 64 {
                eprintln!(
                    "warning: RLIMIT_NOFILE is {} which is too low for {conns} connections",
                    rl.rlim_cur
                );
            }
        }
    }
}

/// Open `n` connections (bounded concurrency), all-or-nothing, in index order.
async fn open_all<T, Fut>(n: usize, mk: impl Fn(usize) -> Fut) -> Result<Vec<T>, String>
where
    T: Send + 'static,
    Fut: Future<Output = io::Result<T>> + Send + 'static,
{
    let sem = Arc::new(Semaphore::new(128));
    let mut set = JoinSet::new();
    for i in 0..n {
        let sem = sem.clone();
        let fut = mk(i);
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.unwrap();
            (i, fut.await)
        });
    }
    let mut out: Vec<Option<T>> = (0..n).map(|_| None).collect();
    let mut opened = 0usize;
    loop {
        match tokio::time::timeout(OPEN_TIMEOUT, set.join_next()).await {
            Err(_) => {
                return Err(format!(
                    "timed out after {OPEN_TIMEOUT:?} opening connections ({opened}/{n} opened)"
                ))
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(format!("connect task failed: {e}")),
            Ok(Some(Ok((i, Err(e))))) => {
                return Err(format!("connection #{i} could not be opened ({opened}/{n} ok): {e}"))
            }
            Ok(Some(Ok((i, Ok(v))))) => {
                out[i] = Some(v);
                opened += 1;
            }
        }
    }
    Ok(out.into_iter().map(|o| o.unwrap()).collect())
}

fn pct(sorted: &[u32], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1] as f64 / 1000.0
}

async fn collect(handles: Vec<tokio::task::JoinHandle<Stats>>) -> Result<Stats, String> {
    let mut total = Stats::default();
    for h in handles {
        let s = h.await.map_err(|e| format!("worker task failed: {e}"))?;
        total.msgs += s.msgs;
        total.pubs += s.pubs;
        total.events += s.events;
        total.streams += s.streams;
        total.bytes += s.bytes;
        total.errors += s.errors;
        total.lat.extend_from_slice(&s.lat);
    }
    total.lat.sort_unstable();
    Ok(total)
}

async fn run(cfg: Cfg) -> Result<String, String> {
    let n = cfg.conns;
    let is_sse = cfg.mode == "sse-burst";
    let target = url::parse(&cfg.url, if is_sse { &["http"] } else { &["ws"] })?;
    let addr = url::resolve(&target).await?;
    eprintln!(
        "{}: {} conns -> {} (resolved {addr}), warmup {}s, measure {}s, payload {}B, {} worker threads",
        cfg.mode, n, cfg.url, cfg.warmup, cfg.secs, cfg.payload, cfg.threads
    );

    // ---- phase 1: open every connection before doing any work ----
    let t_open = Instant::now();
    enum Conns {
        Ws(Vec<ws::WsConn>),
        Sse(Vec<tokio::net::TcpStream>),
    }
    let conns = if is_sse {
        Conns::Sse(open_all(n, move |_| sse::open(addr)).await?)
    } else {
        let (auth, path) = (target.authority.clone(), target.path.clone());
        Conns::Ws(
            open_all(n, move |_| {
                let (a, p) = (auth.clone(), path.clone());
                async move { ws::WsConn::connect(addr, &a, &p).await }
            })
            .await?,
        )
    };
    eprintln!("opened {n} connections in {:.0?}", t_open.elapsed());

    // ---- phase 2: warmup (excluded) then measure ----
    let t0 = Instant::now();
    let warmup_end = t0 + Duration::from_secs_f64(cfg.warmup);
    let measure_end = warmup_end + Duration::from_secs_f64(cfg.secs);
    let clk = Clock { warmup_end, measure_end, hard_end: measure_end + GRACE };

    let mut handles = Vec::with_capacity(n);
    match conns {
        Conns::Ws(v) => {
            // WS_MESSAGE replaces the generated payload (an RPC frame, say).
            let payload = Arc::new(std::env::var("WS_MESSAGE").map(|m| m.into_bytes()).unwrap_or_else(|_| ws::make_payload(cfg.payload)));
            let frame = Arc::new(ws::build_text_frame(&payload));
            for (i, c) in v.into_iter().enumerate() {
                let (f, p) = (frame.clone(), payload.clone());
                handles.push(if cfg.mode == "ws-echo" {
                    tokio::spawn(ws::rtt_task(c, i, f, p, clk, false))
                } else if i == 0 {
                    tokio::spawn(ws::rtt_task(c, i, f, p, clk, true))
                } else {
                    tokio::spawn(ws::reader_task(c, i, clk))
                });
            }
        }
        Conns::Sse(v) => {
            if target.query_n.is_none() {
                eprintln!("warning: url has no n=<events> query parameter; per-stream event count is not verified");
            }
            let request = format!(
                "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\n{}\r\n",
                target.path,
                target.authority,
                if cfg.keepalive { "" } else { "Connection: close\r\n" }
            )
            .into_bytes();
            let scfg = Arc::new(sse::SseCfg {
                addr,
                request,
                expected: target.query_n,
                keepalive: cfg.keepalive,
                buf_size: if n <= 2000 { 64 * 1024 } else { 16 * 1024 },
            });
            for (i, s) in v.into_iter().enumerate() {
                handles.push(tokio::spawn(sse::sse_task(s, i, scfg.clone(), clk)));
            }
        }
    }
    eprintln!("running (warmup {}s, then {}s)...", cfg.warmup, cfg.secs);
    let st = collect(handles).await?;
    eprintln!("done: {} errors", st.errors);

    let secs = cfg.secs;
    let (p50, p99) = (pct(&st.lat, 50.0), pct(&st.lat, 99.0));
    let json = match cfg.mode.as_str() {
        "ws-echo" => format!(
            "{{\"mode\":\"ws-echo\",\"conns\":{n},\"secs\":{secs},\"msgs_per_sec\":{:.1},\"p50_us\":{p50:.1},\"p99_us\":{p99:.1},\"errors\":{}}}",
            st.msgs as f64 / secs,
            st.errors
        ),
        "ws-fanout" => format!(
            "{{\"mode\":\"ws-fanout\",\"conns\":{n},\"secs\":{secs},\"publishes_per_sec\":{:.1},\"deliveries_per_sec\":{:.1},\"p50_us\":{p50:.1},\"p99_us\":{p99:.1},\"errors\":{}}}",
            st.pubs as f64 / secs,
            st.msgs as f64 / secs,
            st.errors
        ),
        _ => format!(
            "{{\"mode\":\"sse-burst\",\"conns\":{n},\"secs\":{secs},\"events_per_sec\":{:.1},\"streams_per_sec\":{:.2},\"mb_per_sec\":{:.2},\"errors\":{}}}",
            st.events as f64 / secs,
            st.streams as f64 / secs,
            st.bytes as f64 / 1e6 / secs,
            st.errors
        ),
    };
    Ok(json)
}

fn main() {
    let cfg = parse_args();
    raise_nofile(cfg.conns);

    // Backstop: never run past warmup + secs + 9s no matter what.
    let limit = Duration::from_secs_f64(cfg.warmup + cfg.secs) + Duration::from_secs(9);
    std::thread::spawn(move || {
        std::thread::sleep(limit);
        eprintln!("fatal: watchdog expired after {limit:.1?}; aborting");
        std::process::exit(3);
    });

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(cfg.threads)
        .enable_all()
        .build()
        .unwrap_or_else(|e| die(&format!("cannot build runtime: {e}")));
    match rt.block_on(run(cfg)) {
        Ok(json) => {
            println!("{json}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("fatal: {e}");
            std::process::exit(1);
        }
    }
}
