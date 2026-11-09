// results.raw -> results.md and results.json (the median run of each case)
import { readFileSync, writeFileSync } from "node:fs";

interface Row { name: string; scenario: string; rps: number; p50ms: number; p99ms: number; success: number; cores: number }
const rows: Row[] = readFileSync(`${import.meta.dir}/results.raw`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const params = JSON.parse(readFileSync(`${import.meta.dir}/params.json`, "utf8"));
const pick = (name: string, scenario: string) => {
  const runs = rows.filter((r) => r.name === name && r.scenario === scenario).sort((a, b) => a.rps - b.rps);
  return runs[Math.floor(runs.length / 2)]!;
};
const cases = { inlineWork: pick("inline", "work"), poolWork: pick("pool", "work"), pingIdle: pick("idle", "ping"), pingInline: pick("inline", "ping-under-load"), pingPool: pick("pool", "ping-under-load") };
const r = (x: Row) => ({ rps: Math.round(x.rps), p50ms: +x.p50ms.toFixed(2), p99ms: +x.p99ms.toFixed(2), cores: +x.cores.toFixed(2), success: x.success });
const out = { params, ...Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, r(v)])) };
writeFileSync(`${import.meta.dir}/results.json`, `${JSON.stringify(out, null, 2)}\n`);
const k = (n: number) => n.toLocaleString("en-US");
const md = `| | requests/s | p50 | p99 | cores used |
|---|---:|---:|---:|---:|
| Work on the serving thread | ${k(out.inlineWork.rps)} | ${out.inlineWork.p50ms} ms | ${out.inlineWork.p99ms} ms | ${out.inlineWork.cores} |
| Work in the pool | ${k(out.poolWork.rps)} | ${out.poolWork.p50ms} ms | ${out.poolWork.p99ms} ms | ${out.poolWork.cores} |

\`/ping\` (does nothing) while the work route is under load:

| | requests/s | p50 | p99 |
|---|---:|---:|---:|
| Idle server | ${k(out.pingIdle.rps)} | ${out.pingIdle.p50ms} ms | ${out.pingIdle.p99ms} ms |
| Work on the serving thread | ${k(out.pingInline.rps)} | ${out.pingInline.p50ms} ms | ${out.pingInline.p99ms} ms |
| Work in the pool | ${k(out.pingPool.rps)} | ${out.pingPool.p50ms} ms | ${out.pingPool.p99ms} ms |
`;
writeFileSync(`${import.meta.dir}/results.md`, md);
console.log(md);
