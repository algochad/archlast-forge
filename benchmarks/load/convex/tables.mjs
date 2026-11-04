#!/usr/bin/env node
// results/*.jsonl -> Markdown tables (results/tables.md): median of the kept runs and the min-max range; runs with errors are left out.
//   node tables.mjs [results/results.jsonl ...]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : [join(HERE, "results/results.jsonl")];
const rows = files.flatMap((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)));

// archlast-forge's fan-out run is discarded by matrix.mjs when updates != writes * clients. Its 50 ms debounce legitimately merges two writes
// that land within 50 ms, so the message count can fall a little short with every client still seeing every write. The Eu run on the same server
// counts what each client saw: when it shows nothing missing, the E run is kept (and its shortfall is in the table).
for (const r of rows) {
  if (r.case === "E" && r.system === "forge" && r.discard && !r.error) {
    const eu = rows.find((x) => x.case === "Eu" && x.config === r.config && x.run === r.run);
    if (eu && eu.missing === 0 && r.updates >= 0.9 * r.expected) (r.discard = false), (r.mergedByDebounce = true);
  }
}
const NAMES = {
  "forge-sqlite-default": "archlast-forge, SQLite, default",
  "forge-sqlite-w2": "archlast-forge, SQLite, RUNTIME_WORKERS=2",
  "forge-postgres-default": "archlast-forge, Postgres, default",
  "forge-postgres-w2-tuned": "archlast-forge, Postgres tuned, RUNTIME_WORKERS=2",
  "forge-mongodb-default": "archlast-forge, MongoDB, default",
  "forge-mongodb-w2": "archlast-forge, MongoDB, RUNTIME_WORKERS=2",
  "forge-mongodb-w2-w1nojournal": "archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false",
  "convex-sqlite-default": "Convex, SQLite, default",
  "convex-sqlite-opt": "Convex, SQLite, optimized",
  "convex-postgres-default": "Convex, Postgres, default",
  "convex-postgres-opt-tuned": "Convex, Postgres tuned, optimized",
  control: "control (Bun.serve, fixed body)",
};
const ORDER = Object.keys(NAMES);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const range = (a, d = 0) => { const lo = Math.min(...a), hi = Math.max(...a); const f = (x) => (d ? x.toFixed(d) : Math.round(x).toLocaleString("en-US")); return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`; };
const cell = (a, d) => `${d ? med(a).toFixed(d) : Math.round(med(a)).toLocaleString("en-US")} (${range(a, d)})`;

const TITLES = {
  A: "A. Cached query, closed loop (64 connections), one hot list",
  Aopen: "A. Cached query, open loop at 2,000 req/s",
  B: "B. Uncached query over 64 lists, closed loop (forge: CACHE_TTL_MS=0; Convex: its result cache as it is)",
  Bopen: "B. Same, open loop at 2,000 req/s",
  Bnc: "B′. Convex without its result cache (a throwaway argument per call), closed loop",
  Bncopen: "B′. Same, open loop at 2,000 req/s",
  C: "C. Insert mutation, closed loop, inserts spread over the 64 lists",
  Copen: "C. Insert mutation, open loop at 500 req/s",
  D: "D. Read-modify-write mutation (toggle), closed loop, cycling the 1,280 todos",
  Dopen: "D. Read-modify-write, open loop at 500 req/s",
};
let out = "";
const usable = (r) => !r.discard && !r.error;
for (const [c, title] of Object.entries(TITLES)) {
  const by = new Map();
  for (const r of rows.filter((r) => r.case === c)) (by.get(r.config) ?? by.set(r.config, []).get(r.config)).push(r);
  if (!by.size) continue;
  out += `\n#### ${title}\n\n| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const id of ORDER) {
    const all = by.get(id);
    if (!all) continue;
    const ok = all.filter(usable);
    const dropped = all.length - ok.length;
    if (!ok.length) { out += `| ${NAMES[id]} | 0 of ${all.length} | all runs discarded: ${all.map((r) => r.error ?? JSON.stringify(r.verifyProblems?.[0] ?? r.load?.non2xx + " non-2xx")).join("; ").slice(0, 120)} | | | | | |\n`; continue; }
    const rps = ok.map((r) => r.load.rps);
    const noisy = (Math.max(...rps) - Math.min(...rps)) / med(rps) > 0.25;
    const cores = ok.map((r) => r.cpu.split(",").slice(0, 3).map((x) => +x.split(":")[1]).reduce((a, b) => a + b, 0));
    out += `| ${NAMES[id]} | ${ok.length}/${all.length}${dropped ? " (" + dropped + " discarded)" : ""} | ${cell(rps)}${noisy ? " **noisy**" : ""} | ${cell(ok.map((r) => r.load.p50), 2)} | ${cell(ok.map((r) => r.load.p90), 2)} | ${cell(ok.map((r) => r.load.p99), 2)} | ${ok.reduce((n, r) => n + r.load.non2xx, 0)} | ${Math.round(med(cores))} of 300 |\n`;
  }
}
for (const [c, title] of [["E", "E. Reactive fan-out: 1,000 subscribers on one live query, 10 inserts/s for 15 s (delivery latency in ms, from the write's send time)"], ["Eu", "E′. The same, archlast-forge measured with the Convex port's client code (WebSocket in Node)"]]) {
  const by = new Map();
  for (const r of rows.filter((r) => r.case === c)) (by.get(r.config) ?? by.set(r.config, []).get(r.config)).push(r);
  if (!by.size) continue;
  out += `\n#### ${title}\n\n| System / config | kept runs | p50 | p90 | p99 | max | per-write p50 / p99 | updates received / expected | clients that saw every write | settle after last write ms | function re-runs per write |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const id of ORDER) {
    const all = by.get(id);
    if (!all) continue;
    const ok = all.filter(usable);
    if (!ok.length) { out += `| ${NAMES[id]} | 0 of ${all.length} | all runs discarded: ${all.map((r) => r.error ?? `${r.updates}/${r.expected} updates, missing ${r.missing}`).join("; ").slice(0, 120)} | | | | | | | | |\n`; continue; }
    const m = (k, d = 0) => (ok.every((r) => r[k] != null) ? cell(ok.map((r) => r[k]), d) : "n/a");
    out += `| ${NAMES[id]} | ${ok.length}/${all.length} | ${m("p50")} | ${m("p90")} | ${m("p99")} | ${m("max")} | ${ok.every((r) => r.perWriteP50 != null) ? `${med(ok.map((r) => r.perWriteP50))} / ${med(ok.map((r) => r.perWriteP99))}` : "n/a"} | ${Math.round(med(ok.map((r) => r.updates))).toLocaleString("en-US")} / ${ok[0].expected.toLocaleString("en-US")} | ${ok.every((r) => r.clientsSeeingEveryWrite != null) ? range(ok.map((r) => r.clientsSeeingEveryWrite)) : "n/a (every update arrived)"} | ${ok.every((r) => r.settleMs != null) ? range(ok.map((r) => r.settleMs)) : "n/a"} | ${ok.every((r) => r.runsPerWrite != null) ? range(ok.map((r) => r.runsPerWrite), 2) : "not measured"} |\n`;
  }
}
const ctl = rows.filter((r) => r.config === "control");
if (ctl.length) {
  out += `\n#### Control: the machine's own noise (Bun.serve answering a fixed 20-document body, same cores and load generator)\n\n| When | case | runs | req/s | p50 | p90 | p99 | max |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
  for (const [when, file] of [["before", files[0]], ["after", files.find((f) => /control-end/.test(f))]]) {
    if (!file) continue;
    const rs = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.config === "control");
    for (const c of ["closed", "open2000"]) {
      const x = rs.filter((r) => r.case === c);
      if (x.length) out += `| ${when} | ${c} | ${x.length} | ${cell(x.map((r) => r.load.rps))} | ${cell(x.map((r) => r.load.p50), 2)} | ${cell(x.map((r) => r.load.p90), 2)} | ${cell(x.map((r) => r.load.p99), 2)} | ${cell(x.map((r) => r.load.max), 1)} |\n`;
    }
  }
}
out += `\n#### Discarded runs and errors\n\n`;
const bad = rows.filter((r) => r.discard || r.error);
out += bad.length ? bad.map((r) => `- run ${r.run} ${r.config} ${r.case ?? r.phase}: ${r.error ?? (r.verifyProblems?.length ? "data check: " + r.verifyProblems.join("; ") : r.load ? r.load.non2xx + " non-2xx" : `updates ${r.updates}/${r.expected}, missing ${r.missing}`)}`).join("\n") : "none";
writeFileSync(join(HERE, "results/tables.md"), out + "\n");
console.log(out);
