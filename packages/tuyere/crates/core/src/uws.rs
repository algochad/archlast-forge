//! uWebSockets' WebSocket protocol layer (frame parser and formatter, close payloads, handshake key), through the C shim in
//! `vendor/uws_shim.cpp`. The parser unmasks in place and reports frames through callbacks; this module owns the state.

use std::os::raw::{c_char, c_int, c_uint, c_void};

#[repr(C)]
struct RawCallbacks {
    user: *mut c_void,
    set_compressed: extern "C" fn(*mut c_void) -> c_int,
    refuse_length: extern "C" fn(*mut c_void, u64) -> c_int,
    fragment: extern "C" fn(*mut c_void, *mut u8, usize, c_uint, c_int, c_int) -> c_int,
    fail: extern "C" fn(*mut c_void, c_int, c_uint, u64, *const c_char, usize),
}

#[repr(C)]
struct RawCloseInfo {
    code: u16,
    message: *const u8,
    message_len: usize,
    failed: c_int,
    fail_close_code: u16,
    fail_kind: c_int,
    diag: *const u8,
    diag_len: usize,
}

extern "C" {
    fn uws_state_new() -> *mut c_void;
    fn uws_state_free(s: *mut c_void);
    fn uws_consume(state: *mut c_void, src: *mut u8, len: c_uint, cb: *mut RawCallbacks);
    fn uws_pre_padding() -> usize;
    fn uws_post_padding() -> usize;
    fn uws_frame_size(n: usize) -> usize;
    fn uws_format(dst: *mut u8, src: *const u8, len: usize, opcode: c_int, compressed: c_int, fin: c_int) -> usize;
    fn uws_format_close(dst: *mut u8, code: u16, msg: *const u8, len: usize) -> usize;
    fn uws_parse_close(src: *mut u8, len: usize, out: *mut RawCloseInfo);
    fn uws_accept_key(key24: *const u8, out28: *mut u8);
}

/// UTF-8 validation for the protocol layer (it calls this where Bun calls simdutf).
#[no_mangle]
pub extern "C" fn archlast_utf8_valid(s: *const u8, n: usize) -> bool {
    // SAFETY: the caller passes a readable range.
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(s, n) }).is_ok()
}

pub const OP_TEXT: i32 = 1;
pub const OP_BINARY: i32 = 2;
pub const OP_CLOSE: i32 = 8;
pub const OP_PING: i32 = 9;
pub const OP_PONG: i32 = 10;

/// What the application does with what the parser finds.
pub trait Handler {
    /// RSV1 arrived on a data frame: accept it (compression negotiated) and remember that this message is compressed.
    fn set_compressed(&mut self) -> bool;
    /// The payload length of a data frame is over the limit.
    fn refuse_length(&mut self, len: u64) -> bool;
    /// A piece of a message or control frame, already unmasked. `remaining` bytes of this frame are still to come.
    /// Return true to stop parsing (the connection is finished).
    fn fragment(&mut self, data: &mut [u8], remaining: u32, opcode: i32, fin: bool) -> bool;
    /// The peer broke the protocol: `close_code` is what to send, `diag` says why.
    fn fail(&mut self, kind: i32, close_code: u16, detail: u64, diag: &str);
}

pub struct Parser {
    state: *mut c_void,
}

// SAFETY: the state is plain data used by one task at a time.
unsafe impl Send for Parser {}

impl Parser {
    pub fn new() -> Parser {
        Parser { state: unsafe { uws_state_new() } }
    }

    /// Bytes the parser needs before and after the data it is given (it unmasks in place and reuses a partial header).
    pub fn pre_padding() -> usize {
        unsafe { uws_pre_padding() }
    }
    pub fn post_padding() -> usize {
        unsafe { uws_post_padding() }
    }

    /// Parses `buf[start..start + len]`. The bytes before `start` (at least `pre_padding()`) and after the data
    /// (`post_padding()`) must be inside `buf`: the parser works there.
    pub fn consume<H: Handler>(&mut self, buf: &mut [u8], start: usize, len: usize, h: &mut H) {
        debug_assert!(start >= Self::pre_padding() && start + len + Self::post_padding() <= buf.len());
        struct Ctx<'a, H: Handler>(&'a mut H);
        extern "C" fn set_compressed<H: Handler>(u: *mut c_void) -> c_int {
            unsafe { &mut *(u as *mut Ctx<H>) }.0.set_compressed() as c_int
        }
        extern "C" fn refuse<H: Handler>(u: *mut c_void, n: u64) -> c_int {
            unsafe { &mut *(u as *mut Ctx<H>) }.0.refuse_length(n) as c_int
        }
        extern "C" fn fragment<H: Handler>(u: *mut c_void, d: *mut u8, n: usize, rem: c_uint, op: c_int, fin: c_int) -> c_int {
            let data = unsafe { std::slice::from_raw_parts_mut(d, n) };
            unsafe { &mut *(u as *mut Ctx<H>) }.0.fragment(data, rem, op, fin != 0) as c_int
        }
        extern "C" fn fail<H: Handler>(u: *mut c_void, kind: c_int, close: c_uint, detail: u64, diag: *const c_char, dlen: usize) {
            let text = unsafe { std::slice::from_raw_parts(diag as *const u8, dlen) };
            unsafe { &mut *(u as *mut Ctx<H>) }.0.fail(kind, close as u16, detail, std::str::from_utf8(text).unwrap_or(""));
        }
        let mut ctx = Ctx(h);
        let mut cb = RawCallbacks {
            user: &mut ctx as *mut Ctx<H> as *mut c_void,
            set_compressed: set_compressed::<H>,
            refuse_length: refuse::<H>,
            fragment: fragment::<H>,
            fail: fail::<H>,
        };
        unsafe { uws_consume(self.state, buf.as_mut_ptr().add(start), len as c_uint, &mut cb) };
    }
}

impl Drop for Parser {
    fn drop(&mut self) {
        unsafe { uws_state_free(self.state) };
    }
}

/// Appends one unmasked server frame to `out`.
pub fn write_frame(out: &mut Vec<u8>, opcode: i32, payload: &[u8], compressed: bool, fin: bool) {
    let need = unsafe { uws_frame_size(payload.len()) };
    out.reserve(need);
    let n = unsafe { uws_format(out.as_mut_ptr().add(out.len()), payload.as_ptr(), payload.len(), opcode, compressed as c_int, fin as c_int) };
    // SAFETY: `uws_format` wrote `n <= need` bytes into the reserved space.
    unsafe { out.set_len(out.len() + n) };
}

/// Appends a close frame: status code (omitted for 1005/1006) and reason.
pub fn write_close(out: &mut Vec<u8>, code: u16, reason: &[u8]) {
    let mut payload = vec![0u8; 2 + reason.len()];
    let n = unsafe { uws_format_close(payload.as_mut_ptr(), code, reason.as_ptr(), reason.len()) };
    payload.truncate(n);
    write_frame(out, OP_CLOSE, &payload, false, true);
}

pub struct Close {
    /// The peer's status code (1005 when it sent none).
    pub code: u16,
    pub reason: Vec<u8>,
    /// `Some((close code to send, why))` when the payload itself is invalid.
    pub invalid: Option<(u16, &'static str)>,
}

/// Parses a close frame's payload with uWebSockets' checks (code ranges, UTF-8 reason).
pub fn parse_close(payload: &mut [u8]) -> Close {
    let mut info = RawCloseInfo { code: 0, message: std::ptr::null(), message_len: 0, failed: 0, fail_close_code: 0, fail_kind: 0, diag: std::ptr::null(), diag_len: 0 };
    unsafe { uws_parse_close(payload.as_mut_ptr(), payload.len(), &mut info) };
    if info.failed != 0 {
        // The diagnostics are static strings in the shim.
        let why = if info.fail_close_code == 1007 { "Received invalid UTF-8" } else { "Received invalid close payload" };
        return Close { code: info.code, reason: Vec::new(), invalid: Some((info.fail_close_code, why)) };
    }
    let reason = if info.message.is_null() { Vec::new() } else { unsafe { std::slice::from_raw_parts(info.message, info.message_len) }.to_vec() };
    Close { code: info.code, reason, invalid: None }
}

/// `Sec-WebSocket-Accept` for a 24-character `Sec-WebSocket-Key`.
pub fn accept_key(key: &[u8]) -> Option<String> {
    if key.len() != 24 {
        return None;
    }
    let mut out = [0u8; 28];
    unsafe { uws_accept_key(key.as_ptr(), out.as_mut_ptr()) };
    String::from_utf8(out.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Rec {
        frags: Vec<(Vec<u8>, u32, i32, bool)>,
        failed: Option<(u16, String)>,
    }
    impl Handler for Rec {
        fn set_compressed(&mut self) -> bool {
            false
        }
        fn refuse_length(&mut self, len: u64) -> bool {
            len > 1000
        }
        fn fragment(&mut self, data: &mut [u8], remaining: u32, opcode: i32, fin: bool) -> bool {
            self.frags.push((data.to_vec(), remaining, opcode, fin));
            false
        }
        fn fail(&mut self, _kind: i32, close_code: u16, _detail: u64, diag: &str) {
            self.failed = Some((close_code, diag.to_string()));
        }
    }

    fn masked(op: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mask = [0x11u8, 0x22, 0x33, 0x44];
        let mut f = vec![(if fin { 0x80 } else { 0 }) | op, 0x80 | payload.len() as u8];
        f.extend_from_slice(&mask);
        f.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        f
    }

    fn run(bytes: &[u8], chunk: usize) -> Rec {
        let pre = Parser::pre_padding();
        let mut p = Parser::new();
        let mut rec = Rec::default();
        for part in bytes.chunks(chunk) {
            let mut buf = vec![0u8; pre + part.len() + Parser::post_padding() + 16];
            buf[pre..pre + part.len()].copy_from_slice(part);
            p.consume(&mut buf, pre, part.len(), &mut rec);
        }
        rec
    }

    #[test]
    fn accept_key_matches_rfc6455() {
        assert_eq!(accept_key(b"dGhlIHNhbXBsZSBub25jZQ==").as_deref(), Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    }

    #[test]
    fn parses_masked_frames_in_any_split() {
        let mut bytes = masked(1, true, b"hello");
        bytes.extend(masked(2, false, b"ab"));
        bytes.extend(masked(0, true, b"cd"));
        for chunk in [1, 2, 3, 5, 7, 100] {
            let rec = run(&bytes, chunk);
            assert!(rec.failed.is_none(), "chunk {chunk}: {:?}", rec.failed);
            let joined: Vec<u8> = rec.frags.iter().flat_map(|f| f.0.clone()).collect();
            assert_eq!(joined, b"helloabcd", "chunk {chunk}");
            assert!(rec.frags.last().unwrap().3, "last piece is the final one");
        }
    }

    #[test]
    fn unmasked_frames_and_big_frames_fail() {
        let rec = run(&[0x81, 0x02, b'h', b'i'], 100);
        assert_eq!(rec.failed.map(|f| f.0), Some(1002));
        let rec = run(&masked(1, true, &vec![b'x'; 120]).iter().cloned().collect::<Vec<_>>(), 1000); // under the limit
        assert!(rec.failed.is_none());
        let mut big = vec![0x81u8, 0x80 | 126, 0x07, 0xd0, 1, 2, 3, 4]; // length 2000 > 1000
        big.extend(vec![0u8; 2000]);
        assert_eq!(run(&big, 100000).failed.map(|f| f.0), Some(1009));
    }

    #[test]
    fn formats_frames_and_close() {
        let mut out = Vec::new();
        write_frame(&mut out, OP_TEXT, b"hi", false, true);
        assert_eq!(out, [0x81, 2, b'h', b'i']);
        out.clear();
        write_frame(&mut out, OP_BINARY, &vec![7u8; 300], true, true);
        assert_eq!(&out[..4], &[0xC2, 126, 0x01, 0x2C]); // fin + rsv1 + binary, 16-bit length 300
        out.clear();
        write_close(&mut out, 1000, b"bye");
        assert_eq!(out, [0x88, 5, 0x03, 0xE8, b'b', b'y', b'e']);
        let mut payload = [0x03u8, 0xE8, b'o', b'k'];
        let c = parse_close(&mut payload);
        assert_eq!((c.code, c.reason.as_slice(), c.invalid.is_none()), (1000, &b"ok"[..], true));
        let mut bad = [0x03u8, 0xED]; // 1005 is not allowed on the wire
        assert!(parse_close(&mut bad).invalid.is_some());
    }
}
