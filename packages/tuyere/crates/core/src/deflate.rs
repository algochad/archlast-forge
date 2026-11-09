//! WebSocket permessage-deflate (RFC 7692).
//!
//! Negotiation of the extension, and the deflate/inflate state a connection keeps (see `wsconn.rs`, which marks
//! compressed frames and calls these).

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// Server-side settings (from `perMessageDeflate`).
#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// Deflate the messages we send (otherwise the extension is only accepted so the peer may compress).
    pub compress: bool,
    /// Keep no compression context between messages (less memory per socket, a little worse ratio).
    pub no_context_takeover: bool,
    /// Largest LZ77 window we use when compressing, 9..=15.
    pub window_bits: u8,
}

/// What was agreed with one peer.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub compress: bool,
    pub server_no_context: bool,
    pub client_no_context: bool,
    pub server_bits: u8,
}

const TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

/// Picks the first acceptable `permessage-deflate` offer in a `Sec-WebSocket-Extensions` header.
/// Returns what was agreed and the header to answer with.
pub fn negotiate(header: &str, cfg: &Config) -> Option<(Params, String)> {
    'offers: for offer in header.split(',') {
        let mut parts = offer.split(';').map(str::trim);
        if !parts.next().is_some_and(|n| n.eq_ignore_ascii_case("permessage-deflate")) {
            continue;
        }
        let (mut s_no, mut c_no) = (false, false);
        let mut s_bits: Option<u8> = None;
        let mut seen = [false; 4];
        for p in parts {
            let (name, value) = match p.split_once('=') {
                Some((n, v)) => (n.trim(), Some(v.trim().trim_matches('"'))),
                None => (p, None),
            };
            let slot = match name.to_ascii_lowercase().as_str() {
                "server_no_context_takeover" => 0,
                "client_no_context_takeover" => 1,
                "server_max_window_bits" => 2,
                "client_max_window_bits" => 3,
                _ => continue 'offers, // an unknown parameter: this offer cannot be honoured
            };
            if std::mem::replace(&mut seen[slot], true) {
                continue 'offers; // repeated parameter
            }
            match slot {
                0 if value.is_none() => s_no = true,
                1 if value.is_none() => c_no = true,
                2 => match value.and_then(|v| v.parse::<u8>().ok()) {
                    Some(n) if (8..=15).contains(&n) => s_bits = Some(n),
                    _ => continue 'offers,
                },
                3 => {
                    // The peer can restrict its own window; we inflate with the full window so anything fits.
                    if value.is_some_and(|v| !v.parse::<u8>().is_ok_and(|n| (8..=15).contains(&n))) {
                        continue 'offers;
                    }
                }
                _ => continue 'offers,
            }
        }
        let bits = cfg.window_bits.clamp(9, 15).min(s_bits.unwrap_or(15));
        if bits < 9 {
            continue; // zlib cannot deflate with an 8-bit window
        }
        let server_no_context = s_no || cfg.no_context_takeover;
        let mut answer = String::from("permessage-deflate");
        if server_no_context {
            answer.push_str("; server_no_context_takeover");
        }
        if c_no {
            answer.push_str("; client_no_context_takeover");
        }
        if bits < 15 {
            answer.push_str(&format!("; server_max_window_bits={bits}"));
        }
        return Some((Params { compress: cfg.compress, server_no_context, client_no_context: c_no, server_bits: bits }, answer));
    }
    None
}

pub(crate) enum Fail {
    TooBig,
    Bad,
}

pub(crate) struct Inflater {
    d: Decompress,
    reset: bool,
}

impl Inflater {
    pub(crate) fn new(reset: bool) -> Self {
        Inflater { d: Decompress::new_with_window_bits(false, 15), reset }
    }

    pub(crate) fn inflate(&mut self, mut data: Vec<u8>, max: usize) -> Result<Vec<u8>, Fail> {
        data.extend_from_slice(&TAIL);
        let mut out: Vec<u8> = Vec::with_capacity((data.len() * 3).min(max).max(256));
        let mut input: &[u8] = &data;
        loop {
            if out.len() == out.capacity() {
                if out.len() >= max {
                    return Err(Fail::TooBig);
                }
                out.reserve(out.capacity().min(max - out.len()).max(1024));
            }
            let before = self.d.total_in();
            let status = self.d.decompress_vec(input, &mut out, FlushDecompress::Sync).map_err(|_| Fail::Bad)?;
            input = &input[(self.d.total_in() - before) as usize..];
            if out.len() > max {
                return Err(Fail::TooBig);
            }
            // Everything consumed and the output buffer not full: nothing is left pending.
            if status == Status::StreamEnd || (input.is_empty() && out.len() < out.capacity()) {
                break;
            }
        }
        if self.reset {
            self.d.reset(false);
        }
        Ok(out)
    }
}

pub(crate) struct Deflater {
    c: Compress,
    reset: bool,
}

impl Deflater {
    pub(crate) fn new(bits: u8, reset: bool) -> Self {
        let level = Compression::new(4);
        let c = if bits == 15 { Compress::new(level, false) } else { Compress::new_with_window_bits(level, false, bits) };
        Deflater { c, reset }
    }

    pub(crate) fn deflate(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::with_capacity(data.len() / 2 + 64);
        let mut input = data;
        loop {
            if out.len() == out.capacity() {
                out.reserve(out.capacity().max(256));
            }
            let before = self.c.total_in();
            let _ = self.c.compress_vec(input, &mut out, FlushCompress::Sync);
            input = &input[(self.c.total_in() - before) as usize..];
            // Done once every input byte is in and the sync flush left room to spare in the output.
            if input.is_empty() && out.len() < out.capacity() {
                break;
            }
        }
        if out.ends_with(&TAIL) {
            out.truncate(out.len() - 4);
        }
        if self.reset {
            self.c.reset();
        }
        out
    }
}
