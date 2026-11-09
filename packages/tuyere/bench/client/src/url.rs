//! Minimal URL parsing (ws://, http://) and one-time address resolution.

use std::net::SocketAddr;

#[derive(Clone, Debug)]
pub struct Target {
    /// "host:port" or "host" exactly as it should appear in the Host header.
    pub authority: String,
    /// Request target: path plus query, always starts with '/'.
    pub path: String,
    pub host: String,
    pub port: u16,
    /// Value of the `n` query parameter, if present and numeric.
    pub query_n: Option<u64>,
}

pub fn parse(url: &str, schemes: &[&str]) -> Result<Target, String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("bad url {url:?}: missing scheme"))?;
    if !schemes.contains(&scheme) {
        return Err(format!(
            "bad url {url:?}: scheme {scheme:?} not supported here (expected one of {schemes:?}; TLS is not supported)"
        ));
    }
    let default_port = 80;
    let rest = rest.split('#').next().unwrap_or("");
    let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..auth_end];
    let tail = &rest[auth_end..];
    let path = if tail.is_empty() {
        "/".to_string()
    } else if tail.starts_with('?') {
        format!("/{tail}")
    } else {
        tail.to_string()
    };
    if authority.is_empty() {
        return Err(format!("bad url {url:?}: empty host"));
    }
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let close = stripped
            .find(']')
            .ok_or_else(|| format!("bad url {url:?}: unterminated IPv6 literal"))?;
        let host = &stripped[..close];
        let after = &stripped[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| format!("bad port in {url:?}"))?,
            None if after.is_empty() => default_port,
            None => return Err(format!("bad url {url:?}")),
        };
        (host.to_string(), port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        (
            h.to_string(),
            p.parse::<u16>().map_err(|_| format!("bad port in {url:?}"))?,
        )
    } else {
        (authority.to_string(), default_port)
    };
    let query_n = path.split_once('?').and_then(|(_, q)| {
        q.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            if k == "n" {
                v.parse::<u64>().ok()
            } else {
                None
            }
        })
    });
    Ok(Target {
        authority: authority.to_string(),
        path,
        host,
        port,
        query_n,
    })
}

pub async fn resolve(t: &Target) -> Result<SocketAddr, String> {
    let mut it = tokio::net::lookup_host((t.host.as_str(), t.port))
        .await
        .map_err(|e| format!("cannot resolve {}:{}: {e}", t.host, t.port))?;
    it.next()
        .ok_or_else(|| format!("no address for {}:{}", t.host, t.port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        let t = parse("ws://127.0.0.1:3000/ws", &["ws"]).unwrap();
        assert_eq!((t.host.as_str(), t.port, t.path.as_str()), ("127.0.0.1", 3000, "/ws"));
        let t = parse("http://localhost:3000/sse?n=1000&x=1", &["http"]).unwrap();
        assert_eq!(t.path, "/sse?n=1000&x=1");
        assert_eq!(t.query_n, Some(1000));
        let t = parse("http://[::1]:81", &["http"]).unwrap();
        assert_eq!((t.host.as_str(), t.port, t.path.as_str()), ("::1", 81, "/"));
        assert!(parse("wss://x/", &["ws"]).is_err());
    }
}
