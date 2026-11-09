//! Node-API addon (loadable by Bun and Node, in the main thread and in workers).

/// Rust-side allocations (request chunks, channels, response bodies) are hot; mimalloc is markedly cheaper than glibc malloc for them.
#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
use tuyere_core as core;
use napi::{bindgen_prelude::*, threadsafe_function::ThreadsafeFunctionCallMode, Error, Result};
use napi_derive::napi;
use std::sync::Arc;

#[napi(object)]
pub struct Started {
    pub id: u32,
    pub port: u32,
}

/// Starts a server with `lanes` JS lanes (call once, from the main thread).
#[napi]
pub fn start(opts: Uint8Array, lanes: u32) -> Result<Started> {
    let (id, port) = core::start(&opts, lanes as usize).map_err(Error::from_reason)?;
    Ok(Started { id, port: port as u32 })
}

/// Begins a graceful shutdown; true if the engine can drain.
#[napi]
pub fn drain_begin(id: u32) -> bool {
    core::drain_begin(id).unwrap_or(false)
}

/// `[pending requests, open WebSockets, open connections]`.
#[napi]
pub fn stats(id: u32) -> Vec<f64> {
    core::stats(id).map_or(vec![0.0; 3], |v| v.iter().map(|n| *n as f64).collect())
}

#[napi]
pub fn topic_count(id: u32, topic: String) -> u32 {
    core::topic_count(id, &topic).map_or(0, |n| n as u32)
}

#[napi]
pub fn ws_buffered(id: u32, ws: u32) -> f64 {
    core::ws_buffered(id, ws).unwrap_or(-1) as f64
}

#[napi]
pub fn close_idle(id: u32) -> u32 {
    core::close_idle(id).map_or(0, |n| n as u32)
}

#[napi]
pub fn open_connections(id: u32) -> u32 {
    core::open_connections(id).map_or(0, |n| n as u32)
}

#[napi]
pub fn stop(id: u32) {
    core::stop(id);
}

/// Marks a lane dead (e.g. its worker crashed) so no new work is routed to it.
#[napi]
pub fn detach_lane(id: u32, lane: u32) {
    let _ = core::detach_lane(id, lane as usize);
}

/// One JS thread's connection to a lane.
#[napi]
pub struct Lane {
    inner: core::LaneHandle,
}

#[napi]
impl Lane {
    /// `notify` is invoked on this thread (coalesced) whenever the lane has work.
    #[napi(constructor)]
    pub fn new(id: u32, lane: u32, notify: Function<(), ()>) -> Result<Self> {
        let tsfn = notify.build_threadsafe_function::<()>().build()?;
        let notify: core::Notify = Arc::new(move || {
            tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });
        let inner = core::attach(id, lane as usize, notify).map_err(Error::from_reason)?;
        Ok(Lane { inner })
    }

    #[napi]
    pub fn drain(&self, mut buf: Uint8Array) -> i32 {
        self.inner.drain(unsafe { buf.as_mut() })
    }

    /// True if work arrived while parking (keep draining); false once the lane is asleep.
    #[napi]
    pub fn park(&self) -> bool {
        self.inner.park()
    }

    #[napi]
    pub fn command(&self, buf: Uint8Array, len: u32) -> Result<()> {
        self.inner.command(&buf[..len as usize]).map_err(Error::from_reason)
    }

    /// Releases the notify callback so it no longer keeps this thread's event loop alive.
    #[napi]
    pub fn detach(&self) {
        self.inner.detach();
    }
}

/// Registers a page template (JSON; see crates/core/src/template.rs) under a name and returns its id. The registry is process-wide.
#[napi]
pub fn register_template(name: String, json: String) -> Result<u32> {
    core::template_register(&name, &json).map_err(Error::from_reason)
}

/// Prints a registered template with `data` (JSON) as its variable `d`.
#[napi]
pub fn render_template(id: u32, data: String) -> Result<String> {
    core::template_render(id, &data).map_err(Error::from_reason)
}
