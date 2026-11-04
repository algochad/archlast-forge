import { openSync, writeSync, fsyncSync, closeSync, rmSync, mkdirSync } from "node:fs";
const dir = process.env.HOME + "/.cache/bench/data/fs"; mkdirSync(dir, { recursive: true });
const fd = openSync(dir + "/f", "w"); const buf = Buffer.alloc(4096, 1); const lat: number[] = [];
for (let i = 0; i < 400; i++) { writeSync(fd, buf); const t = performance.now(); fsyncSync(fd); lat.push(performance.now() - t); }
closeSync(fd); rmSync(dir, { recursive: true });
lat.sort((a, b) => a - b); console.log(`fsync after 4 KiB append: p50 ${lat[200].toFixed(2)} p90 ${lat[360].toFixed(2)} p99 ${lat[396].toFixed(2)} max ${lat[399].toFixed(2)} ms`);
