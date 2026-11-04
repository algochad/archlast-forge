import { openSync, writeSync, closeSync, fsync, rmSync, mkdirSync } from "node:fs";
const dir = process.env.HOME + "/.cache/bench/data/afs"; mkdirSync(dir, { recursive: true });
const fd = openSync(dir + "/f", "w"); const buf = Buffer.alloc(4096, 1);
let ticks = 0, maxGap = 0, last = performance.now();
const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 1);
const lat: number[] = []; const t0 = performance.now();
for (let i = 0; i < 300; i++) { writeSync(fd, buf); const t = performance.now(); await new Promise<void>((res, rej) => fsync(fd, (e) => (e ? rej(e) : res()))); lat.push(performance.now() - t); }
const el = performance.now() - t0; clearInterval(iv); closeSync(fd); rmSync(dir, { recursive: true });
lat.sort((a, b) => a - b);
console.log(`async fsync p50 ${lat[150].toFixed(2)} ms; 1 ms timer ticked ${ticks} times in ${el.toFixed(0)} ms (expected ~${Math.round(el)}); max gap ${maxGap.toFixed(1)} ms`);
