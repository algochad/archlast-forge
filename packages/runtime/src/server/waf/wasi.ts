// The WASI preview-1 imports the Coraza module (TinyGo) uses, in plain JS. Derived from @coraza/core's wasi.ts (Apache-2.0, see
// THIRD_PARTY_NOTICES.md).
//
// Why not `node:wasi`: Bun's runs Go's `main` to its `proc_exit(0)` and then really exits the process, silently, in the middle of boot.
// Node's `start()` treats that exit as the end of `_start` and leaves the instance usable, and so does this: `proc_exit` throws
// `WasiExit`, and `start` swallows it when the code is 0.
import { randomFillSync } from "node:crypto";

const SUCCESS = 0;
const BADF = 8;
const STDOUT = 1;
const STDERR = 2;

class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`WASI proc_exit(${code})`);
  }
}

export function createWasi(opts: { onOutput(fd: 1 | 2, text: string): void; memory(): WebAssembly.Memory }) {
  const view = () => new DataView(opts.memory().buffer);
  const imports: Record<string, (...args: any[]) => number | void> = {
    clock_time_get(_id: number, _precision: bigint, out: number) {
      view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
      return SUCCESS;
    },
    args_sizes_get(argc: number, size: number) {
      const dv = view();
      dv.setUint32(argc, 0, true);
      dv.setUint32(size, 0, true);
      return SUCCESS;
    },
    args_get: () => SUCCESS,
    environ_sizes_get(count: number, size: number) {
      const dv = view();
      dv.setUint32(count, 0, true);
      dv.setUint32(size, 0, true);
      return SUCCESS;
    },
    environ_get: () => SUCCESS,
    fd_write(fd: number, iovs: number, iovsLen: number, written: number) {
      if (fd !== STDOUT && fd !== STDERR) return BADF;
      const dv = view();
      const memory = new Uint8Array(dv.buffer);
      let text = "";
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true);
        const len = dv.getUint32(iovs + i * 8 + 4, true);
        text += Buffer.from(memory.subarray(ptr, ptr + len)).toString("utf8");
        total += len;
      }
      if (text) opts.onOutput(fd, text.replace(/\n$/, ""));
      dv.setUint32(written, total, true);
      return SUCCESS;
    },
    // Coraza is built without file access, so nothing here is on a request's path.
    fd_close: () => BADF,
    fd_fdstat_get: () => BADF,
    fd_filestat_get: () => BADF,
    fd_prestat_get: () => BADF,
    fd_prestat_dir_name: () => BADF,
    fd_read: () => BADF,
    fd_readdir: () => BADF,
    fd_seek: () => BADF,
    path_filestat_get: () => BADF,
    path_open: () => BADF,
    proc_exit(code: number) {
      throw new WasiExit(code);
    },
    sched_yield: () => SUCCESS,
    random_get(ptr: number, len: number) {
      randomFillSync(new Uint8Array(opts.memory().buffer, ptr, len));
      return SUCCESS;
    },
  };
  return {
    imports,
    /** Runs the module's `_start`; a clean exit from it is how a Go program ends its `main`, and the exports stay callable afterwards. */
    start(instance: WebAssembly.Instance) {
      const start = instance.exports._start as (() => void) | undefined;
      if (!start) return;
      try {
        start();
      } catch (e) {
        if (!(e instanceof WasiExit && e.code === 0)) throw e;
      }
    },
  };
}
