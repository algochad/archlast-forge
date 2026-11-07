//! Little-endian cursor helpers and header (de)serialization shared by every message type.
use axum::http::{HeaderMap, HeaderName, HeaderValue};

pub struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Reader { b, p: 0 }
    }
    pub fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.p + n > self.b.len() {
            return Err("truncated buffer".into());
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    pub fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    pub fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn str(&mut self, n: usize) -> Result<&'a str, String> {
        std::str::from_utf8(self.take(n)?).map_err(|e| e.to_string())
    }
}

/// Skips `count` headers of `[u16 nlen][name][u16 vlen][value]` and returns the raw bytes they occupy.
pub fn skip_headers<'a>(r: &mut Reader<'a>, count: u16) -> Result<&'a [u8], String> {
    let start = r.p;
    for _ in 0..count {
        let n = r.u16()? as usize;
        r.take(n)?;
        let v = r.u16()? as usize;
        r.take(v)?;
    }
    Ok(&r.b[start..r.p])
}

pub fn parse_headers(raw: &[u8], count: u16, into: &mut HeaderMap) {
    let mut r = Reader::new(raw);
    for _ in 0..count {
        let (Ok(n), Ok(v)) = (r.u16().and_then(|n| r.take(n as usize)), r.u16().and_then(|v| r.take(v as usize))) else {
            return;
        };
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(n), HeaderValue::from_bytes(v)) {
            into.append(name, value);
        }
    }
}

/// Appends `u16 count, u32 byteLen, headers...` for a request/upgrade.
pub fn write_headers(out: &mut Vec<u8>, headers: &HeaderMap) {
    out.extend_from_slice(&(headers.len().min(u16::MAX as usize) as u16).to_le_bytes());
    let len_at = out.len();
    out.extend_from_slice(&[0u8; 4]);
    for (name, value) in headers.iter().take(u16::MAX as usize) {
        let (n, v) = (name.as_str().as_bytes(), value.as_bytes());
        let vl = v.len().min(u16::MAX as usize);
        out.extend_from_slice(&(n.len() as u16).to_le_bytes());
        out.extend_from_slice(n);
        out.extend_from_slice(&(vl as u16).to_le_bytes());
        out.extend_from_slice(&v[..vl]);
    }
    let len = (out.len() - len_at - 4) as u32;
    out[len_at..len_at + 4].copy_from_slice(&len.to_le_bytes());
}
