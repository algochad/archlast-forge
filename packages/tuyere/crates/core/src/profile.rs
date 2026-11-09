//! Development sampling profiler (feature `profile`): `ARCHLAST_PROFILE=<file>:<seconds>` samples the whole process
//! with SIGPROF at 1 kHz (no ptrace or perf permissions needed), then writes "thread;frame;frame count" lines.

use std::{io::Write, sync::Once};

static ONCE: Once = Once::new();

pub fn maybe_start() {
    ONCE.call_once(|| {
        let Ok(spec) = std::env::var("ARCHLAST_PROFILE") else { return };
        let (path, secs) = match spec.rsplit_once(':') {
            Some((p, s)) => (p.to_string(), s.parse::<u64>().unwrap_or(10)),
            None => (spec.clone(), 10),
        };
        let guard = match pprof::ProfilerGuardBuilder::default().frequency(1000).blocklist(&["libc", "libgcc", "pthread", "vdso"]).build() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("archlast profile: {e}");
                return;
            }
        };
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(secs));
            if let Ok(report) = guard.report().build() {
                if let Ok(mut f) = std::fs::File::create(&path) {
                    for (frames, count) in &report.data {
                        let mut line = frames.thread_name.clone();
                        for sym in frames.frames.iter().rev() {
                            if let Some(s) = sym.first() {
                                line.push(';');
                                line.push_str(&s.name());
                            }
                        }
                        let _ = writeln!(f, "{line} {count}");
                    }
                }
            }
        });
    });
}
