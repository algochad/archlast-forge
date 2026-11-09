//! A cache of complete responses, answered from the I/O threads without waking JS.
//!
//! A handler opts a response in with one header, `x-archlast-cache`, which the engine removes before sending:
//!
//!   x-archlast-cache: ttl=30; vary-cookie=forge-tz,theme; skip-cookie=session,other; skip-header=authorization; tag=posts,home
//!
//! * `ttl` (seconds, required) is how long the entry is served.
//! * `vary-cookie` names the cookies whose values are part of the key (a different value is a different entry).
//! * `only-cookie` lists the only cookies a request may carry (besides the varied ones): any other cookie bypasses the cache.
//! * `skip-cookie` / `skip-header` name a cookie or header whose presence on a request bypasses the cache altogether (nothing is looked up
//!   or stored): how a page for signed-in visitors never meets the entries made for anonymous ones.
//! * `tag` labels the entry for `purge`.
//!
//! The first cacheable response for a path registers the rules for that path (a "spec"); a request is looked up by path, its key built from the
//! spec, then the entry found. Only complete 200 responses to GET are stored, and never one that sets a cookie or says `no-store`/`private`.
//! The body is kept as it was and, for text, gzip-compressed once at store time.
use axum::body::Bytes;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

pub const CONFIG_HEADER: &str = "x-archlast-cache";
const SHARDS: usize = 16;
/// Bodies below this are not worth compressing.
const GZIP_MIN: usize = 512;

#[derive(Default, Debug, PartialEq)]
pub struct Config {
    pub ttl: Duration,
    pub vary_cookie: Vec<String>,
    pub skip_cookie: Vec<String>,
    pub skip_header: Vec<String>,
    /// When set, a request with any cookie not named here or in `vary_cookie` bypasses the cache.
    pub only_cookie: Option<Vec<String>>,
    pub tags: Vec<String>,
}

pub fn parse_config(v: &str) -> Option<Config> {
    let mut c = Config::default();
    let mut ttl = None;
    for part in v.split(';') {
        let Some((k, val)) = part.trim().split_once('=') else { continue };
        let list = || val.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        match k.trim() {
            "ttl" => ttl = val.trim().parse::<u64>().ok().filter(|n| *n > 0),
            "vary-cookie" => c.vary_cookie = list(),
            "skip-cookie" => c.skip_cookie = list(),
            "skip-header" => c.skip_header = list().into_iter().map(|h| h.to_ascii_lowercase()).collect(),
            "only-cookie" => c.only_cookie = Some(list()),
            "tag" => c.tags = list(),
            _ => {}
        }
    }
    c.ttl = Duration::from_secs(ttl?);
    Some(c)
}

/// The rules of one path, kept from the first response that set them.
struct Spec {
    vary_cookie: Vec<String>,
    skip_cookie: Vec<String>,
    skip_header: Vec<String>,
    only_cookie: Option<Vec<String>>,
}

struct Entry {
    status: StatusCode,
    headers: Vec<(HeaderName, HeaderValue)>,
    identity: Bytes,
    gzip: Option<Bytes>,
    etag: HeaderValue,
    expires: Instant,
    tags: Vec<String>,
    seq: u64,
}

impl Entry {
    fn size(&self) -> usize {
        self.identity.len() + self.gzip.as_ref().map_or(0, |g| g.len()) + 256
    }
}

/// What a lookup found.
pub enum Hit {
    Full { status: StatusCode, headers: Vec<(HeaderName, HeaderValue)>, body: Bytes, gzip: bool, has_gzip: bool, etag: HeaderValue },
    NotModified { etag: HeaderValue },
}

pub struct PageCache {
    specs: RwLock<HashMap<String, Arc<Spec>>>,
    shards: [Mutex<HashMap<String, Arc<Entry>>>; SHARDS],
    bytes: AtomicUsize,
    max_bytes: usize,
    seq: std::sync::atomic::AtomicU64,
    /// Whether anything is stored: the common request skips the cache with one load.
    pub active: std::sync::atomic::AtomicBool,
}

impl PageCache {
    pub fn new(max_bytes: usize) -> Self {
        PageCache {
            specs: RwLock::new(HashMap::new()),
            shards: std::array::from_fn(|_| Mutex::new(HashMap::new())),
            bytes: AtomicUsize::new(0),
            max_bytes,
            seq: std::sync::atomic::AtomicU64::new(0),
            active: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn shard(&self, key: &str) -> &Mutex<HashMap<String, Arc<Entry>>> {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in key.as_bytes() {
            h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
        }
        &self.shards[(h as usize) % SHARDS]
    }

    /// The key of a request under a spec, or None when the request must bypass the cache.
    fn key(spec: &Spec, path_and_query: &str, host: &str, headers: &HeaderMap) -> Option<String> {
        for h in &spec.skip_header {
            if headers.contains_key(h.as_str()) {
                return None;
            }
        }
        let cookies: Vec<(&str, &str)> = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|p| p.trim().split_once('='))
            .collect();
        if cookies.iter().any(|(n, _)| spec.skip_cookie.iter().any(|s| s == n)) {
            return None;
        }
        if let Some(only) = &spec.only_cookie {
            if cookies.iter().any(|(n, _)| !only.iter().chain(spec.vary_cookie.iter()).any(|s| s == n)) {
                return None;
            }
        }
        let mut key = String::with_capacity(path_and_query.len() + host.len() + 32);
        key.push_str(host);
        key.push('\0');
        key.push_str(path_and_query);
        for name in &spec.vary_cookie {
            key.push('\0');
            key.push_str(name);
            key.push('=');
            if let Some((_, v)) = cookies.iter().find(|(n, _)| n == name) {
                key.push_str(v);
            }
        }
        Some(key)
    }

    pub fn lookup(&self, path: &str, path_and_query: &str, host: &str, headers: &HeaderMap, accept_gzip: bool) -> Option<Hit> {
        let spec = self.specs.read().unwrap().get(path)?.clone();
        let key = Self::key(&spec, path_and_query, host, headers)?;
        let entry = self.shard(&key).lock().unwrap().get(&key).cloned()?;
        if entry.expires <= Instant::now() {
            self.remove(&key);
            return None;
        }
        if let Some(inm) = headers.get(header::IF_NONE_MATCH) {
            if crate::http::etag_matches(inm.as_bytes(), entry.etag.as_bytes()) {
                return Some(Hit::NotModified { etag: entry.etag.clone() });
            }
        }
        let (body, gzip) = match (&entry.gzip, accept_gzip) {
            (Some(g), true) => (g.clone(), true),
            _ => (entry.identity.clone(), false),
        };
        Some(Hit::Full { status: entry.status, headers: entry.headers.clone(), body, gzip, has_gzip: entry.gzip.is_some(), etag: entry.etag.clone() })
    }

    fn remove(&self, key: &str) {
        if let Some(e) = self.shard(key).lock().unwrap().remove(key) {
            self.bytes.fetch_sub(e.size(), Ordering::Relaxed);
        }
    }

    /// Stores a response made for a request, under the rules it asked for. Returns false when it was not stored.
    #[allow(clippy::too_many_arguments)] // the request (path, key parts, headers) and the response (status, headers, body), side by side
    pub fn store(&self, path: &str, path_and_query: &str, host: &str, req_headers: &HeaderMap, cfg: Config, status: StatusCode, headers: Vec<(HeaderName, HeaderValue)>, body: Bytes) -> bool {
        if status != StatusCode::OK || body.len() > self.max_bytes / 8 {
            return false;
        }
        let spec = Arc::new(Spec { vary_cookie: cfg.vary_cookie, skip_cookie: cfg.skip_cookie, skip_header: cfg.skip_header, only_cookie: cfg.only_cookie });
        let Some(key) = Self::key(&spec, path_and_query, host, req_headers) else { return false };
        let text = headers.iter().any(|(n, v)| n == header::CONTENT_TYPE && (v.as_bytes().starts_with(b"text/") || v.as_bytes().starts_with(b"application/json") || v.as_bytes().starts_with(b"application/javascript") || v.as_bytes().starts_with(b"image/svg")));
        let already_encoded = headers.iter().any(|(n, _)| n == header::CONTENT_ENCODING);
        let gzip = (text && !already_encoded && body.len() >= GZIP_MIN).then(|| gzip(&body)).filter(|g| g.len() < body.len());
        let etag = {
            let mut h: u64 = 0xcbf29ce484222325;
            for b in body.iter() {
                h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
            }
            HeaderValue::from_str(&format!("W/\"{:x}-{:x}\"", body.len(), h)).unwrap()
        };
        let entry = Arc::new(Entry { status, headers, identity: body, gzip, etag, expires: Instant::now() + cfg.ttl, tags: cfg.tags, seq: self.seq.fetch_add(1, Ordering::Relaxed) });
        let size = entry.size();
        self.specs.write().unwrap().insert(path.to_string(), spec);
        if let Some(old) = self.shard(&key).lock().unwrap().insert(key, entry) {
            self.bytes.fetch_sub(old.size(), Ordering::Relaxed);
        }
        self.bytes.fetch_add(size, Ordering::Relaxed);
        self.active.store(true, Ordering::Release);
        if self.bytes.load(Ordering::Relaxed) > self.max_bytes {
            self.evict();
        }
        true
    }

    /// Drops expired entries, then the oldest, until the cache is under its limit again.
    fn evict(&self) {
        let now = Instant::now();
        let mut all: Vec<(String, u64, bool)> = Vec::new();
        for s in &self.shards {
            for (k, e) in s.lock().unwrap().iter() {
                all.push((k.clone(), e.seq, e.expires <= now));
            }
        }
        all.sort_by_key(|(_, seq, expired)| (!*expired, *seq));
        for (k, _, _) in all {
            if self.bytes.load(Ordering::Relaxed) <= self.max_bytes * 3 / 4 {
                break;
            }
            self.remove(&k);
        }
    }

    /// Drops every entry carrying one of `tags`, or all of them when `tags` is empty. Returns how many.
    pub fn purge(&self, tags: &[String]) -> usize {
        let mut n = 0;
        for s in &self.shards {
            let mut g = s.lock().unwrap();
            let doomed: Vec<String> = g.iter().filter(|(_, e)| tags.is_empty() || e.tags.iter().any(|t| tags.contains(t))).map(|(k, _)| k.clone()).collect();
            for k in doomed {
                if let Some(e) = g.remove(&k) {
                    self.bytes.fetch_sub(e.size(), Ordering::Relaxed);
                    n += 1;
                }
            }
        }
        n
    }
}

fn gzip(body: &[u8]) -> Bytes {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(body.len() / 3), flate2::Compression::new(6));
    let _ = enc.write_all(body);
    Bytes::from(enc.finish().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(cookie: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(c) = cookie {
            h.insert(header::COOKIE, HeaderValue::from_str(c).unwrap());
        }
        h
    }
    fn cfg() -> Config {
        parse_config("ttl=30; vary-cookie=tz; skip-cookie=session; tag=a,b").unwrap()
    }
    fn ct() -> Vec<(HeaderName, HeaderValue)> {
        vec![(header::CONTENT_TYPE, HeaderValue::from_static("text/html"))]
    }

    #[test]
    fn config_parses_and_needs_a_ttl() {
        let c = cfg();
        assert_eq!((c.ttl, c.vary_cookie, c.skip_cookie, c.tags), (Duration::from_secs(30), vec!["tz".into()], vec!["session".into()], vec!["a".into(), "b".into()]));
        assert!(parse_config("vary-cookie=tz").is_none());
        assert!(parse_config("ttl=0").is_none());
        assert!(parse_config("ttl=x").is_none());
    }

    #[test]
    fn stores_and_hits_by_path_query_and_varied_cookie() {
        let c = PageCache::new(1 << 20);
        let body = Bytes::from(vec![b'x'; 2000]);
        assert!(c.store("/p", "/p?a=1", "h", &headers(Some("tz=UTC")), cfg(), StatusCode::OK, ct(), body.clone()));
        let hit = |pq: &str, ck: Option<&str>, gz: bool| c.lookup("/p", pq, "h", &headers(ck), gz);
        assert!(matches!(hit("/p?a=1", Some("tz=UTC"), false), Some(Hit::Full { gzip: false, .. })));
        assert!(matches!(hit("/p?a=1", Some("tz=UTC; other=1"), true), Some(Hit::Full { gzip: true, .. })));
        assert!(hit("/p?a=2", Some("tz=UTC"), false).is_none()); // another query
        assert!(hit("/p?a=1", Some("tz=Asia/Manila"), false).is_none()); // another zone
        assert!(hit("/p?a=1", None, false).is_none()); // no zone cookie is a key of its own
    }

    #[test]
    fn a_request_with_a_skip_cookie_or_header_never_meets_the_cache() {
        let c = PageCache::new(1 << 20);
        assert!(c.store("/p", "/p", "h", &headers(None), parse_config("ttl=30; skip-cookie=session; skip-header=Authorization").unwrap(), StatusCode::OK, ct(), Bytes::from_static(b"hi")));
        assert!(c.lookup("/p", "/p", "h", &headers(None), false).is_some());
        assert!(c.lookup("/p", "/p", "h", &headers(Some("session=abc")), false).is_none());
        let mut h = headers(None);
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer x"));
        assert!(c.lookup("/p", "/p", "h", &h, false).is_none());
        // and a response made for such a request is not stored
        assert!(!c.store("/p", "/p", "h", &headers(Some("session=abc")), parse_config("ttl=30; skip-cookie=session").unwrap(), StatusCode::OK, ct(), Bytes::from_static(b"private")));
    }

    #[test]
    fn only_cookie_lets_just_the_named_cookies_through() {
        let c = PageCache::new(1 << 20);
        assert!(c.store("/p", "/p", "h", &headers(None), parse_config("ttl=30; vary-cookie=tz; only-cookie=consent").unwrap(), StatusCode::OK, ct(), Bytes::from_static(b"hi")));
        assert!(c.lookup("/p", "/p", "h", &headers(Some("tz=UTC")), false).is_none()); // another key
        assert!(c.lookup("/p", "/p", "h", &headers(None), false).is_some());
        assert!(c.lookup("/p", "/p", "h", &headers(Some("consent=1")), false).is_some());
        assert!(c.lookup("/p", "/p", "h", &headers(Some("session=abc")), false).is_none()); // a cookie nobody listed
        assert!(c.lookup("/p", "/p", "h", &headers(Some("analytics=1; consent=1")), false).is_none());
    }

    #[test]
    fn if_none_match_is_a_304_and_a_stale_entry_is_a_miss() {
        let c = PageCache::new(1 << 20);
        let mut cf = cfg();
        c.store("/p", "/p", "h", &headers(None), parse_config("ttl=30").unwrap(), StatusCode::OK, ct(), Bytes::from_static(b"hello"));
        let Some(Hit::Full { etag, .. }) = c.lookup("/p", "/p", "h", &headers(None), false) else { panic!("miss") };
        let mut h = headers(None);
        h.insert(header::IF_NONE_MATCH, etag);
        assert!(matches!(c.lookup("/p", "/p", "h", &h, false), Some(Hit::NotModified { .. })));
        cf.ttl = Duration::from_millis(1);
        c.store("/q", "/q", "h", &headers(Some("tz=UTC")), cf, StatusCode::OK, ct(), Bytes::from_static(b"x"));
        std::thread::sleep(Duration::from_millis(5));
        assert!(c.lookup("/q", "/q", "h", &headers(Some("tz=UTC")), false).is_none());
    }

    #[test]
    fn purge_by_tag_or_all_and_the_size_limit() {
        let c = PageCache::new(1 << 20);
        c.store("/a", "/a", "h", &headers(None), parse_config("ttl=30; tag=x").unwrap(), StatusCode::OK, ct(), Bytes::from_static(b"a"));
        c.store("/b", "/b", "h", &headers(None), parse_config("ttl=30; tag=y").unwrap(), StatusCode::OK, ct(), Bytes::from_static(b"b"));
        assert_eq!(c.purge(&["x".into()]), 1);
        assert!(c.lookup("/a", "/a", "h", &headers(None), false).is_none());
        assert!(c.lookup("/b", "/b", "h", &headers(None), false).is_some());
        assert_eq!(c.purge(&[]), 1);
        let small = PageCache::new(4096);
        for i in 0..40 {
            small.store(&format!("/{i}"), &format!("/{i}"), "h", &headers(None), parse_config("ttl=30").unwrap(), StatusCode::OK, ct(), Bytes::from(vec![b'x'; 300]));
        }
        assert!(small.bytes.load(Ordering::Relaxed) <= 4096);
    }

    #[test]
    fn only_200s_are_stored() {
        let c = PageCache::new(1 << 20);
        assert!(!c.store("/p", "/p", "h", &headers(None), cfg(), StatusCode::NOT_FOUND, ct(), Bytes::from_static(b"no")));
    }
}
