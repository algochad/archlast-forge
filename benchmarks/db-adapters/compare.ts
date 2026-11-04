// Puts the result files of run-all.sh side by side, as a Markdown table: p50 in ms for the latency lines (lower is better), operations a second
// for the throughput lines (higher is better).
//   bun benchmarks/db-adapters/compare.ts [results-dir] [name,name,…]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? join(import.meta.dir, "results");
const wanted = process.argv[3]?.split(",");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).filter((n) => !wanted || wanted.includes(n));
const order = ["sqlite", "postgres-default", "postgres-tuned", "mongodb"];
files.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
const runs = files.map((f) => JSON.parse(readFileSync(join(dir, f + ".json"), "utf8")) as { db: string; seeded: number; results: { op: string; p50?: number; p99?: number; perSec?: number }[] });
const ops = [...new Set(runs.flatMap((r) => r.results.map((x) => x.op)))];
const fmt = (x: { p50?: number; perSec?: number } | undefined) => (!x ? "–" : x.perSec !== undefined ? x.perSec.toLocaleString("en-US") : x.p50! < 10 ? x.p50!.toFixed(2) : x.p50!.toFixed(1));
console.log(`| operation | ${files.join(" | ")} |`);
console.log(`|---|${files.map(() => "---:").join("|")}|`);
for (const op of ops) console.log(`| ${op}${runs[0]!.results.find((x) => x.op === op)?.perSec !== undefined ? " (per second)" : " (p50 ms)"} | ${runs.map((r) => fmt(r.results.find((x) => x.op === op))).join(" | ")} |`);
console.log(`\n${runs.map((r, i) => `${files[i]}: ${r.seeded.toLocaleString("en-US")} documents`).join("; ")}`);
