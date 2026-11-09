//! C ABI for `bun:ffi`. A server is addressed by id; each JS thread attaches to a lane and gets a handle.

/// Rust-side allocations (request chunks, channels, response bodies) are hot; mimalloc is markedly cheaper than glibc malloc for them.
#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
use tuyere_core as core;
use core::LaneHandle;
use std::{cell::RefCell, slice, sync::Arc};

thread_local! { static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) }; }

fn fail<T>(e: String, v: T) -> T {
    LAST_ERROR.with(|l| *l.borrow_mut() = e);
    v
}

/// Starts a server with `lanes` JS lanes. Returns its id, or 0 on failure (see `archlast_last_error`).
/// # Safety
/// Every pointer argument must be valid for the length given with it, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_start(opts: *const u8, opts_len: u32, lanes: u32) -> u32 {
    match core::start(slice::from_raw_parts(opts, opts_len as usize), lanes as usize) {
        Ok((id, _)) => id,
        Err(e) => fail(e, 0),
    }
}

/// Copies the last error message into `buf`; returns its full length.
/// # Safety
/// Every pointer argument must be valid for the length given with it, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_last_error(buf: *mut u8, cap: u32) -> u32 {
    LAST_ERROR.with(|l| {
        let s = l.borrow();
        let n = s.len().min(cap as usize);
        std::ptr::copy_nonoverlapping(s.as_ptr(), buf, n);
        s.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn archlast_port(id: u32) -> u32 {
    core::port(id).map_or(0, |p| p as u32)
}

/// Attaches the calling JS thread to `lane`. `notify` is a threadsafe `JSCallback`. Returns null on failure.
#[no_mangle]
pub extern "C" fn archlast_attach(id: u32, lane: u32, notify: extern "C" fn()) -> *mut LaneHandle {
    // An `extern "C" fn` is not a Rust `Fn`, so the closure is the adapter clippy would like to remove.
    #[allow(clippy::redundant_closure)]
    let wake = Arc::new(move || notify());
    match core::attach(id, lane as usize, wake) {
        Ok(h) => Box::into_raw(Box::new(h)),
        Err(e) => fail(e, std::ptr::null_mut()),
    }
}

/// Moves queued events into / sends a command batch from the lane's buffer.
/// # Safety
/// `h` must be a live handle from `archlast_attach` and the buffer valid for the length given, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_drain(h: *const LaneHandle, buf: *mut u8, cap: u32) -> i32 {
    (*h).drain(slice::from_raw_parts_mut(buf, cap as usize))
}

/// Returns 1 if work arrived while parking (keep draining), 0 once the lane is asleep.
/// # Safety
/// Every pointer argument must be valid for the length given with it, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_park(h: *const LaneHandle) -> i32 {
    (*h).park() as i32
}

/// Moves queued events into / sends a command batch from the lane's buffer.
/// # Safety
/// `h` must be a live handle from `archlast_attach` and the buffer valid for the length given, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_command(h: *const LaneHandle, buf: *const u8, len: u32) -> i32 {
    match (*h).command(slice::from_raw_parts(buf, len as usize)) {
        Ok(()) => 0,
        Err(e) => fail(e, -1),
    }
}

/// Detaches the lane and frees the handle.
/// # Safety
/// Every pointer argument must be valid for the length given with it, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_detach(h: *mut LaneHandle) {
    let h = Box::from_raw(h);
    h.detach();
}

#[no_mangle]
pub extern "C" fn archlast_detach_lane(id: u32, lane: u32) {
    let _ = core::detach_lane(id, lane as usize);
}

/// Begins a graceful shutdown; returns 1 if the engine can drain, else 0.
#[no_mangle]
pub extern "C" fn archlast_drain_begin(id: u32) -> i32 {
    core::drain_begin(id).map_or(0, |b| b as i32)
}

/// Fills `out[0..3]` with pending requests, open WebSockets and open connections.
/// # Safety
/// Every pointer argument must be valid for the length given with it, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_stats(id: u32, out: *mut u64) -> i32 {
    match core::stats(id) {
        Ok(v) => {
            std::ptr::copy_nonoverlapping(v.as_ptr(), out, 3);
            0
        }
        Err(_) => -1,
    }
}

/// Number of sockets subscribed to a topic.
/// # Safety
/// `topic` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn archlast_topic_count(id: u32, topic: *const u8, len: u32) -> u32 {
    let t = std::str::from_utf8(slice::from_raw_parts(topic, len as usize)).unwrap_or("");
    core::topic_count(id, t).map_or(0, |n| n as u32)
}

#[no_mangle]
pub extern "C" fn archlast_ws_buffered(id: u32, ws: u32) -> i64 {
    core::ws_buffered(id, ws).unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn archlast_close_idle(id: u32) -> u32 {
    core::close_idle(id).map_or(0, |n| n as u32)
}

#[no_mangle]
pub extern "C" fn archlast_open_connections(id: u32) -> u32 {
    core::open_connections(id).map_or(0, |n| n as u32)
}

#[no_mangle]
pub extern "C" fn archlast_stop(id: u32) {
    core::stop(id);
}

/// Registers a page template (JSON; see `crates/core/src/template.rs`) under a name; returns its id, or -1 on failure (see `archlast_last_error`).
/// The registry belongs to this library: templates registered through the Node-API addon are not here.
/// # Safety
/// Every pointer argument must be valid for the length given with it, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_template_register(name: *const u8, name_len: u32, json: *const u8, json_len: u32) -> i64 {
    let (name, json) = (slice::from_raw_parts(name, name_len as usize), slice::from_raw_parts(json, json_len as usize));
    match (std::str::from_utf8(name), std::str::from_utf8(json)) {
        (Ok(n), Ok(j)) => match core::template_register(n, j) {
            Ok(id) => id as i64,
            Err(e) => fail(e, -1),
        },
        _ => fail("template is not UTF-8".into(), -1),
    }
}

/// Prints template `id` with `data` (JSON) into `out`. Returns the bytes written, `-needed` if `cap` is too small (call again with room),
/// or `i32::MIN` on failure (see `archlast_last_error`).
/// # Safety
/// Every pointer argument must be valid for the length given with it, for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn archlast_template_render(id: u32, data: *const u8, data_len: u32, out: *mut u8, cap: u32) -> i32 {
    let Ok(data) = std::str::from_utf8(slice::from_raw_parts(data, data_len as usize)) else { return fail("data is not UTF-8".into(), i32::MIN) };
    match core::template_render(id, data) {
        Ok(page) if page.len() <= cap as usize => {
            std::ptr::copy_nonoverlapping(page.as_ptr(), out, page.len());
            page.len() as i32
        }
        Ok(page) => -(page.len() as i32),
        Err(e) => fail(e, i32::MIN),
    }
}
