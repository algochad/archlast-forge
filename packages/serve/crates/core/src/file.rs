//! File responses: streamed from disk in 64 KiB chunks, with HEAD, single-range Range (206/416) and ETag /
//! Last-Modified validation (304). Nothing is buffered, so multi-GiB downloads cost no memory.
use crate::http::{RBody, Resp};
use crate::state::FileReply;
use crate::wire::parse_headers;
use axum::{
    body::Bytes,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
};
use futures_util::Stream;
use std::{
    io::SeekFrom,
    pin::Pin,
    task::{Context, Poll},
    time::{Duration, SystemTime},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

pub struct FileBody(Pin<Box<ReaderStream<tokio::io::Take<tokio::fs::File>>>>);

impl FileBody {
    pub fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<Option<Result<Bytes, std::io::Error>>> {
        self.0.as_mut().poll_next(cx)
    }
}

fn plain(status: StatusCode, text: &'static str) -> Resp {
    let mut r = Resp::new(RBody::Full(Some(Bytes::from_static(text.as_bytes()))));
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain;charset=utf-8"));
    r
}

enum RangeResult {
    Whole,
    Part(u64, u64),
    Unsatisfiable,
}

/// A single `bytes=` range. Anything we do not understand (other units, several ranges, malformed) means "ignore
/// the header and send the whole file", which RFC 9110 allows.
fn parse_range(h: &str, len: u64) -> RangeResult {
    let Some(spec) = h.trim().strip_prefix("bytes=") else { return RangeResult::Whole };
    if spec.contains(',') {
        return RangeResult::Whole;
    }
    let Some((a, b)) = spec.split_once('-') else { return RangeResult::Whole };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        let Ok(n) = b.parse::<u64>() else { return RangeResult::Whole };
        if n == 0 || len == 0 {
            return RangeResult::Unsatisfiable;
        }
        return RangeResult::Part(len.saturating_sub(n), len - 1);
    }
    let Ok(start) = a.parse::<u64>() else { return RangeResult::Whole };
    let end = if b.is_empty() {
        u64::MAX
    } else {
        match b.parse::<u64>() {
            Ok(e) if e >= start => e,
            _ => return RangeResult::Whole,
        }
    };
    if start >= len {
        return RangeResult::Unsatisfiable;
    }
    RangeResult::Part(start, end.min(len - 1))
}

fn charset_for(mime: &str) -> bool {
    mime.starts_with("text/") || matches!(mime, "application/json" | "application/javascript" | "application/xml" | "image/svg+xml")
}

fn etag_matches(header_value: &str, etag: &str) -> bool {
    let weak = |s: &str| s.trim().trim_start_matches("W/").to_string();
    header_value.trim() == "*" || header_value.split(',').any(|t| weak(t) == weak(etag))
}

pub async fn serve(method: &Method, req: &HeaderMap, f: FileReply) -> Resp {
    let meta = match tokio::fs::metadata(&f.path).await {
        Ok(m) if m.is_file() => m,
        _ => return plain(StatusCode::NOT_FOUND, "Not Found"),
    };
    let len = meta.len();
    let modified = meta.modified().ok();
    let etag = modified
        .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| format!("W/\"{:x}-{:x}\"", len, d.as_nanos()));
    let last_modified = modified.map(httpdate::fmt_http_date);

    let mut headers = HeaderMap::new();
    parse_headers(&f.headers, f.header_count, &mut headers);
    let status = StatusCode::from_u16(f.status).unwrap_or(StatusCode::OK);
    let readable = method == Method::GET || method == Method::HEAD;

    // Validators: 304 for an unchanged file (plain 200 responses only).
    if status == StatusCode::OK && readable {
        let inm = req.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
        let fresh = match (inm, &etag) {
            (Some(v), Some(e)) => etag_matches(v, e),
            (Some(_), None) => false,
            (None, _) => match (req.get(header::IF_MODIFIED_SINCE).and_then(|v| v.to_str().ok()).and_then(|v| httpdate::parse_http_date(v).ok()), modified) {
                (Some(since), Some(m)) => m.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) <= since.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
                _ => false,
            },
        };
        if fresh {
            let mut r = Resp::new(RBody::Full(None));
            *r.status_mut() = StatusCode::NOT_MODIFIED;
            if let Some(e) = etag.as_deref().and_then(|e| HeaderValue::from_str(e).ok()) {
                r.headers_mut().insert(header::ETAG, e);
            }
            if let Some(l) = last_modified.as_deref().and_then(|l| HeaderValue::from_str(l).ok()) {
                r.headers_mut().insert(header::LAST_MODIFIED, l);
            }
            return r;
        }
    }

    // Range (ignored when If-Range does not match the current file).
    let (mut start, mut end, mut code) = (0u64, len.saturating_sub(1), status);
    if f.range && status == StatusCode::OK && readable {
        let if_range_ok = match req.get(header::IF_RANGE).and_then(|v| v.to_str().ok()) {
            None => true,
            Some(v) => etag.as_deref() == Some(v) || last_modified.as_deref() == Some(v),
        };
        if if_range_ok {
            if let Some(h) = req.get(header::RANGE).and_then(|v| v.to_str().ok()) {
                match parse_range(h, len) {
                    RangeResult::Whole => {}
                    RangeResult::Part(s, e) => {
                        (start, end, code) = (s, e, StatusCode::PARTIAL_CONTENT);
                        if let Ok(v) = HeaderValue::from_str(&format!("bytes {s}-{e}/{len}")) {
                            headers.insert(header::CONTENT_RANGE, v);
                        }
                    }
                    RangeResult::Unsatisfiable => {
                        let mut r = plain(StatusCode::RANGE_NOT_SATISFIABLE, "Range Not Satisfiable");
                        if let Ok(v) = HeaderValue::from_str(&format!("bytes */{len}")) {
                            r.headers_mut().insert(header::CONTENT_RANGE, v);
                        }
                        return r;
                    }
                }
            }
        }
    }
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    if !headers.contains_key(header::CONTENT_TYPE) {
        // An explicit type is used verbatim; a derived one gets a charset where it makes sense.
        let value = if f.content_type.is_empty() {
            let mime = mime_guess::from_path(&f.path).first_or_octet_stream().essence_str().to_string();
            if charset_for(&mime) { format!("{mime};charset=utf-8") } else { mime }
        } else {
            f.content_type.clone()
        };
        if let Ok(v) = HeaderValue::from_str(&value) {
            headers.insert(header::CONTENT_TYPE, v);
        }
    }
    if f.range {
        headers.entry(header::ACCEPT_RANGES).or_insert(HeaderValue::from_static("bytes"));
    }
    if let Some(v) = etag.as_deref().and_then(|e| HeaderValue::from_str(e).ok()) {
        headers.entry(header::ETAG).or_insert(v);
    }
    if let Some(v) = last_modified.as_deref().and_then(|l| HeaderValue::from_str(l).ok()) {
        headers.entry(header::LAST_MODIFIED).or_insert(v);
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body_len));

    let body = if *method == Method::HEAD || body_len == 0 {
        RBody::Full(None)
    } else {
        let mut file = match tokio::fs::File::open(&f.path).await {
            Ok(file) => file,
            Err(_) => return plain(StatusCode::NOT_FOUND, "Not Found"),
        };
        if start > 0 && file.seek(SeekFrom::Start(start)).await.is_err() {
            return plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error");
        }
        RBody::File(FileBody(Box::pin(ReaderStream::with_capacity(file.take(body_len), 64 * 1024))))
    };
    let mut r = Resp::new(body);
    *r.status_mut() = code;
    *r.headers_mut() = headers;
    let _ = Duration::ZERO;
    r
}
