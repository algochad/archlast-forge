//! Thread-per-core engine: N OS threads, each running a single-threaded tokio runtime that accepts from a shared
//! listening socket, so a connection never leaves its thread (no work stealing, no cross-thread task wake-ups).
//! Connections are served by raw hyper http1 and tracked for idle timeouts and graceful shutdown.
use crate::{http, state::{IoInbox, Shared}};
use hyper_util::rt::TokioIo;
use socket2::{Domain, Protocol, Socket, Type};
use std::future::Future;
use std::{
    cell::Cell,
    convert::Infallible,
    io,
    net::{SocketAddr, ToSocketAddrs},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering::{self, Relaxed}},
        Arc, OnceLock, Weak,
    },
    task::{Context, Poll},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpStream, UnixStream},
    sync::watch,
};

thread_local! { static IO_INDEX: Cell<usize> = const { Cell::new(usize::MAX) }; }

/// Index of the current I/O thread, or `usize::MAX` outside the thread-per-core engine.
pub fn io_index() -> usize {
    IO_INDEX.with(|c| c.get())
}

/// Milliseconds-since-start clock, refreshed every 100 ms by each I/O thread, so reading it on every read/write is
/// one atomic load. A connection can therefore look at most ~100 ms older than it is, never up to a second.
static CLOCK: AtomicU64 = AtomicU64::new(0);
static START: OnceLock<Instant> = OnceLock::new();

fn now_ms() -> u64 {
    START.get().map_or(0, |s| s.elapsed().as_millis() as u64)
}

/// Shutdown states broadcast to every I/O thread.
const RUN: u8 = 0;
const DRAIN: u8 = 1;
const FORCE: u8 = 2;

/// Per-connection state shared between the connection task, the reaper and the request path.
pub struct ConnState {
    last: AtomicU64,
    /// 0: use the server default. `u32::MAX`: never time out. n: n seconds (a per-request override).
    timeout: AtomicU32,
    /// Set once the connection was upgraded to a WebSocket (it then follows the WebSocket idle timeout).
    pub ws: AtomicBool,
    /// Requests currently being handled on this connection.
    in_flight: AtomicU32,
    /// The connection runs over TLS.
    pub tls: AtomicBool,
    /// Set when the connection must close now (idle too long, or `close_now`), and the stop level (RUN, DRAIN, FORCE) the
    /// I/O thread last announced. The connection task is woken through `waker` instead of polling two futures on every wake.
    closing: AtomicBool,
    shutdown: AtomicU8,
    waker: futures_util::task::AtomicWaker,
    /// This I/O thread's open-connection count, so a drain can wait for upgraded WebSockets too.
    local_open: Arc<AtomicUsize>,
}

impl ConnState {
    fn new(local_open: Arc<AtomicUsize>) -> Self {
        ConnState { last: AtomicU64::new(now_ms()), timeout: AtomicU32::new(0), ws: AtomicBool::new(false), in_flight: AtomicU32::new(0), tls: AtomicBool::new(false), closing: AtomicBool::new(false), shutdown: AtomicU8::new(RUN), waker: futures_util::task::AtomicWaker::new(), local_open }
    }
    pub fn request_started(&self) {
        self.in_flight.fetch_add(1, Relaxed);
    }
    pub fn request_ended(&self) {
        self.in_flight.fetch_sub(1, Relaxed);
    }
    /// A keep-alive connection waiting for its next request (not a WebSocket).
    pub fn is_idle(&self) -> bool {
        self.in_flight.load(Relaxed) == 0 && !self.ws.load(Relaxed)
    }
    pub fn close_now(&self) {
        self.closing.store(true, Ordering::Release);
        self.waker.wake();
    }
    /// Tells the connection task how far the server is stopping.
    fn signal_mode(&self, mode: u8) {
        if self.shutdown.swap(mode, Ordering::AcqRel) != mode {
            self.waker.wake();
        }
    }
    /// Completes when the idle reaper decides this connection has been silent too long.
    pub async fn idle_expired(&self) {
        std::future::poll_fn(|cx| {
            self.waker.register(cx.waker());
            if self.closing.load(Ordering::Acquire) {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await
    }
    /// Counts an upgraded WebSocket as an open connection until `ws_ended`.
    pub fn ws_started(&self, sh: &Shared) {
        self.local_open.fetch_add(1, Relaxed);
        sh.open_conns.fetch_add(1, Relaxed);
    }
    pub fn ws_ended(&self, sh: &Shared) {
        self.local_open.fetch_sub(1, Relaxed);
        sh.open_conns.fetch_sub(1, Relaxed);
    }
    fn touch(&self) {
        self.last.store(CLOCK.load(Relaxed), Relaxed);
    }
    /// Our own writes count as activity for plain HTTP (an SSE heartbeat keeps its stream open) but not for an
    /// upgraded WebSocket: our pings say nothing about the peer, only what it sends us does.
    fn touch_write(&self) {
        if !self.ws.load(Relaxed) {
            self.touch();
        }
    }
    /// `0` disables the idle timeout until the request completes; n sets it to n seconds.
    pub fn set_timeout(&self, secs: u32) {
        self.timeout.store(if secs == 0 { u32::MAX } else { secs }, Relaxed);
    }
    pub fn reset_timeout(&self) {
        self.timeout.store(0, Relaxed);
    }
}

/// A connection from a TCP or a unix-domain listener.
enum Conn {
    Tcp(TcpStream),
    Unix(UnixStream),
}

macro_rules! conn_delegate {
    ($self:ident, $s:ident => $e:expr) => {
        match $self.get_mut() {
            Conn::Tcp($s) => $e,
            Conn::Unix($s) => $e,
        }
    };
}

impl AsyncRead for Conn {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        conn_delegate!(self, s => Pin::new(s).poll_read(cx, buf))
    }
}

impl AsyncWrite for Conn {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        conn_delegate!(self, s => Pin::new(s).poll_write(cx, buf))
    }
    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        conn_delegate!(self, s => Pin::new(s).poll_write_vectored(cx, bufs))
    }
    fn is_write_vectored(&self) -> bool {
        match self {
            Conn::Tcp(s) => s.is_write_vectored(),
            Conn::Unix(s) => s.is_write_vectored(),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        conn_delegate!(self, s => Pin::new(s).poll_flush(cx))
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        conn_delegate!(self, s => Pin::new(s).poll_shutdown(cx))
    }
}

/// A connection that records activity (under TLS, so the encrypted bytes on the wire are what counts).
pub(crate) struct Tracked {
    inner: Conn,
    st: Arc<ConnState>,
}

impl AsyncRead for Tracked {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.st.touch();
        }
        r
    }
}

impl AsyncWrite for Tracked {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) {
            self.st.touch_write();
        }
        r
    }
    fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) {
            self.st.touch_write();
        }
        r
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// What hyper reads and writes: the tracked connection, wrapped in TLS when the server is HTTPS.
pub(crate) enum Io {
    Plain(Tracked),
    Tls(Box<tokio_rustls::server::TlsStream<Tracked>>),
}

macro_rules! io_delegate {
    ($self:ident, $s:ident => $e:expr) => {
        match $self.get_mut() {
            Io::Plain($s) => $e,
            Io::Tls($s) => $e,
        }
    };
}

impl AsyncRead for Io {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        io_delegate!(self, s => Pin::new(s).poll_read(cx, buf))
    }
}

impl AsyncWrite for Io {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        io_delegate!(self, s => Pin::new(s).poll_write(cx, buf))
    }
    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> {
        io_delegate!(self, s => Pin::new(s).poll_write_vectored(cx, bufs))
    }
    fn is_write_vectored(&self) -> bool {
        match self {
            Io::Plain(s) => s.is_write_vectored(),
            Io::Tls(s) => s.is_write_vectored(),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        io_delegate!(self, s => Pin::new(s).poll_flush(cx))
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        io_delegate!(self, s => Pin::new(s).poll_shutdown(cx))
    }
}

pub struct Tpc {
    mode: watch::Sender<u8>,
    _threads: Vec<JoinHandle<()>>,
    /// The socket file of a unix-domain server, removed when the server stops.
    unix_path: Option<String>,
}

impl Tpc {
    /// Stop accepting; in-flight requests finish, idle connections close. Non-blocking.
    pub fn drain(&self) {
        let _ = self.mode.send_if_modified(|m| if *m == RUN { *m = DRAIN; true } else { false });
    }
    /// Drop every connection now.
    pub fn stop(self) {
        let _ = self.mode.send(FORCE);
        if let Some(p) = &self.unix_path {
            if !p.starts_with('\0') && !p.starts_with('@') {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// Largest request head accepted (request line and headers); bigger ones get a 431, as in Bun (16 KiB).
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// What a server listens on.
pub enum Listen {
    Tcp { host: String, port: u16, reuse_port: bool, ipv6_only: bool },
    Unix(String),
}

enum StdListener {
    Tcp(std::net::TcpListener),
    Unix(std::os::unix::net::UnixListener),
}

impl StdListener {
    fn try_clone(&self) -> io::Result<StdListener> {
        Ok(match self {
            StdListener::Tcp(l) => StdListener::Tcp(l.try_clone()?),
            StdListener::Unix(l) => StdListener::Unix(l.try_clone()?),
        })
    }
}

fn bind_tcp(host: &str, port: u16, reuse_port: bool, ipv6_only: bool) -> Result<std::net::TcpListener, String> {
    let addr: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("resolve {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("resolve {host}: no address"))?;
    let err = |e: io::Error| format!("bind {addr}: {e}");
    let s = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP)).map_err(err)?;
    s.set_reuse_address(true).map_err(err)?;
    // A sender whose segments are larger than the receive window stops dead, and on loopback the segment size is 64 KiB. A
    // small autotuned receive buffer plus a reader that drains in small pieces (TLS records) reached exactly that: the peer
    // sat in its persist state with 1 MB queued while our window stayed at 24 KiB. A 1 MiB buffer (accepted sockets inherit
    // it) keeps the window above the segment size; the kernel only uses it as data arrives. ARCHLAST_RCVBUF=0 leaves it to
    // autotuning.
    let rcvbuf = std::env::var("ARCHLAST_RCVBUF").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(1 << 20);
    if rcvbuf > 0 {
        s.set_recv_buffer_size(rcvbuf).map_err(err)?;
    }
    if reuse_port {
        s.set_reuse_port(true).map_err(err)?;
    }
    if addr.is_ipv6() {
        s.set_only_v6(ipv6_only).map_err(err)?;
    }
    s.set_nonblocking(true).map_err(err)?;
    s.bind(&addr.into()).map_err(err)?;
    s.listen(4096).map_err(err)?;
    Ok(s.into())
}

fn bind_unix(path: &str) -> Result<std::os::unix::net::UnixListener, String> {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::fs::FileTypeExt;
    // "\0name" or "@name": a socket in the abstract namespace (no file to clean up).
    if let Some(name) = path.strip_prefix('\0').or_else(|| path.strip_prefix('@')) {
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).map_err(|e| format!("bind {path}: {e}"))?;
        let l = std::os::unix::net::UnixListener::bind_addr(&addr).map_err(|e| format!("bind {path}: {e}"))?;
        l.set_nonblocking(true).map_err(|e| e.to_string())?;
        return Ok(l);
    }
    // A socket file left behind by a previous run would make bind fail; remove it, but never anything else.
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_socket() {
            let _ = std::fs::remove_file(path);
        } else {
            return Err(format!("bind {path}: the path exists and is not a socket"));
        }
    }
    let l = std::os::unix::net::UnixListener::bind(path).map_err(|e| format!("bind {path}: {e}"))?;
    l.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(l)
}

pub fn start(shared: Arc<Shared>, listen: Listen, n: usize) -> Result<(Tpc, u16), String> {
    // Default: ONE listening socket (so a port in use still fails to bind), duplicated into every thread, which
    // all accept from the same queue. `reuse_port` instead binds one SO_REUSEPORT socket per thread
    // (kernel-balanced, but then any other SO_REUSEPORT server of this user can silently share the port).
    let n = n.max(1);
    let (mut listeners, bound, unix_path) = match &listen {
        Listen::Tcp { host, port, reuse_port, ipv6_only } => {
            let first = bind_tcp(host, *port, *reuse_port, *ipv6_only)?;
            let bound = first.local_addr().map_err(|e| e.to_string())?.port();
            let mut v = vec![StdListener::Tcp(first)];
            for _ in 1..n {
                v.push(if *reuse_port { StdListener::Tcp(bind_tcp(host, bound, true, *ipv6_only)?) } else { v[0].try_clone().map_err(|e| e.to_string())? });
            }
            (v, bound, None)
        }
        Listen::Unix(path) => {
            let first = StdListener::Unix(bind_unix(path)?);
            let mut v = Vec::with_capacity(n);
            for _ in 1..n {
                v.push(first.try_clone().map_err(|e| e.to_string())?);
            }
            v.insert(0, first);
            (v, 0, Some(path.clone()))
        }
    };
    START.get_or_init(Instant::now);
    let (tx, rx) = watch::channel(RUN);
    let inboxes: Vec<Arc<IoInbox>> = (0..listeners.len()).map(|_| Arc::new(IoInbox::default())).collect();
    let _ = shared.io.set(inboxes.clone());
    let mut threads = Vec::with_capacity(listeners.len());
    for (i, l) in listeners.drain(..).enumerate() {
        let sh = shared.clone();
        let mode = rx.clone();
        let inbox = inboxes[i].clone();
        let t = std::thread::Builder::new()
            .name(format!("archlast-io-{i}"))
            .spawn(move || {
                IO_INDEX.with(|c| c.set(i));
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
                rt.block_on(io_thread(sh, l, mode, inbox));
            })
            .map_err(|e| e.to_string())?;
        threads.push(t);
    }
    Ok((Tpc { mode: tx, _threads: threads, unix_path }, bound))
}

async fn io_thread(sh: Arc<Shared>, l: StdListener, mut mode: watch::Receiver<u8>, inbox: Arc<IoInbox>) {
    // Delivers responses queued by JS threads to this thread's requests (local wake-ups only).
    fn deliver(inbox: &IoInbox) {
        let items = std::mem::take(&mut *inbox.q.lock().unwrap());
        let out = std::mem::take(&mut *inbox.ws.lock().unwrap());
        inbox.pending.fetch_sub(items.len() + out.len(), Relaxed);
        for (tx, reply) in items {
            let _ = tx.send(reply);
        }
        for (tx, msg) in out {
            let _ = tx.send(msg);
        }
    }
    let inbox_spin = inbox.clone();
    tokio::spawn(async move {
        loop {
            inbox.notify.notified().await;
            deliver(&inbox);
        }
    });
    // Polls the inbox for a short while after this thread handed work to JS, instead of sleeping in epoll: the answer
    // usually follows within microseconds, and a wake-up from sleep costs several. `yield_now` keeps the runtime
    // serving sockets (non-blocking I/O poll) between checks.
    let spin_ns = sh.spin_ns;
    if spin_ns > 0 {
        tokio::spawn(async move {
            loop {
                inbox_spin.spin.notified().await;
                let mut until = Instant::now() + Duration::from_nanos(spin_ns);
                while Instant::now() < until {
                    if inbox_spin.pending.load(Relaxed) > 0 {
                        deliver(&inbox_spin);
                        until = Instant::now() + Duration::from_nanos(spin_ns);
                    }
                    tokio::task::yield_now().await;
                }
            }
        });
    }

    enum Listener {
        Tcp(tokio::net::TcpListener),
        Unix(tokio::net::UnixListener),
    }
    let listener = match l {
        StdListener::Tcp(l) => Listener::Tcp(tokio::net::TcpListener::from_std(l).expect("listener")),
        StdListener::Unix(l) => Listener::Unix(tokio::net::UnixListener::from_std(l).expect("listener")),
    };
    let local_open = Arc::new(AtomicUsize::new(0));
    let mut conns: Vec<Weak<ConnState>> = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks = 0u32;

    loop {
        tokio::select! {
            r = async {
                match &listener {
                    Listener::Tcp(l) => l.accept().await.map(|(s, p)| {
                        let _ = s.set_nodelay(true);
                        (Conn::Tcp(s), Some(p))
                    }),
                    Listener::Unix(l) => l.accept().await.map(|(s, _)| (Conn::Unix(s), None)),
                }
            } => {
                let Ok((stream, peer)) = r else { continue };
                let st = Arc::new(ConnState::new(local_open.clone()));
                conns.push(Arc::downgrade(&st));
                {
                    let mut reg = sh.conn_registry.lock().unwrap();
                    if reg.len() > 64 + 2 * sh.open_conns.load(Relaxed) {
                        reg.retain(|w| w.strong_count() > 0);
                    }
                    reg.push(Arc::downgrade(&st));
                }
                local_open.fetch_add(1, Relaxed);
                sh.open_conns.fetch_add(1, Relaxed);
                tokio::spawn(serve_conn(sh.clone(), stream, peer, st, local_open.clone()));
            }
            _ = tick.tick() => {
                let now = now_ms();
                CLOCK.fetch_max(now, Relaxed);
                ticks = ticks.wrapping_add(1);
                if !ticks.is_multiple_of(10) { continue; } // scan for idle connections once a second
                conns.retain(|w| match w.upgrade() {
                    None => false,
                    Some(st) => {
                        let limit = match st.timeout.load(Relaxed) {
                            u32::MAX => 0,
                            0 => if st.ws.load(Relaxed) { sh.ws_idle } else { sh.idle },
                            n => n,
                        };
                        if limit > 0 && now.saturating_sub(st.last.load(Relaxed)) > limit as u64 * 1000 {
                            st.close_now();
                        }
                        true
                    }
                });
            }
            _ = mode.changed() => {
                if *mode.borrow() >= DRAIN { break; }
            }
        }
    }
    drop(listener);
    // Draining: stay alive until this thread's connections are done (or the stop is forced).
    loop {
        let m = *mode.borrow();
        for w in &conns {
            if let Some(st) = w.upgrade() {
                st.signal_mode(m);
            }
        }
        if local_open.load(Relaxed) == 0 || m >= FORCE {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn serve_conn(sh: Arc<Shared>, stream: Conn, peer: Option<SocketAddr>, st: Arc<ConnState>, local_open: Arc<AtomicUsize>) {
    let finish = |sh: &Shared, local_open: &AtomicUsize| {
        local_open.fetch_sub(1, Relaxed);
        sh.open_conns.fetch_sub(1, Relaxed);
    };
    let tracked = Tracked { inner: stream, st: st.clone() };
    let io = match &sh.tls {
        None => Io::Plain(tracked),
        Some(acceptor) => {
            st.tls.store(true, Relaxed);
            // The handshake must not hang a connection slot forever.
            match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tracked)).await {
                Ok(Ok(tls)) => Io::Tls(Box::new(tls)),
                _ => return finish(&sh, &local_open),
            }
        }
    };
    let svc = {
        let (sh, st) = (sh.clone(), st.clone());
        hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
            let (sh, st) = (sh.clone(), st.clone());
            async move { Ok::<_, Infallible>(http::handle(sh, peer, Some(st), req).await) }
        })
    };
    let h2 = matches!(&io, Io::Tls(t) if t.get_ref().1.alpn_protocol() == Some(b"h2".as_slice()));
    // One loop for both protocols: the connection futures differ in type but share the shape we use.
    macro_rules! drive {
        ($conn:expr) => {{
            let conn = $conn;
            tokio::pin!(conn);
            let mut graceful = false;
            // One poll function instead of a select over the connection and two rarely-firing futures: the flags are
            // plain atomics, and the waker is registered once per wake.
            std::future::poll_fn(|cx| {
                st.waker.register(cx.waker());
                if st.closing.load(Ordering::Acquire) {
                    return Poll::Ready(()); // idle too long
                }
                match st.shutdown.load(Ordering::Acquire) {
                    FORCE => return Poll::Ready(()),
                    DRAIN if !graceful => {
                        graceful = true;
                        conn.as_mut().graceful_shutdown(); // finishes the requests in flight, then closes
                    }
                    _ => {}
                }
                conn.as_mut().poll(cx).map(|_| ())
            })
            .await;
        }};
    }
    if h2 {
        drive!(hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new()).serve_connection(TokioIo::new(io), svc));
    } else {
        drive!(hyper::server::conn::http1::Builder::new().max_buf_size(MAX_HEADER_BYTES).writev(false).serve_connection(TokioIo::new(io), svc).with_upgrades());
    }
    finish(&sh, &local_open);
}
