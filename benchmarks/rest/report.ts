// results.raw (one JSON line per run) -> results.md: the median run of each server and scenario, and results.json for the docs site.
//   bun report.ts
import { readFileSync, writeFileSync } from "node:fs";

interface Row { name: string; scenario: string; run?: number; rps?: number; p50ms?: number; p99ms?: number; success?: number; cores?: number; peakMiB?: number }
const rows: Row[] = readFileSync(`${import.meta.dir}/results.raw`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const LABELS: Record<string, string> = {
  axum: "Rust (Axum 0.8, Tokio)",
  go: "Go (fasthttp)",
  dotnet: ".NET 10 (Minimal APIs)",
  bun: "Bun.serve",
  serve: "archlast-serve (native App API, 3 I/O threads)",
  node: "Node.js 24 (Express 5)",
  forge: "archlast-forge (NestJS path, archlast-serve)",
  "forge-light": "archlast-forge (forge/http.ts light routes, archlast-serve)",
  "forge-bun": "archlast-forge (NestJS path, Bun.serve)",
  "forge-notelemetry": "archlast-forge (NestJS path, archlast-serve, telemetry off)",
};
const SCENARIOS = ["read", "list", "update", "create"] as const;
const median = (runs: Row[]) => [...runs].sort((a, b) => a.rps! - b.rps!)[Math.floor(runs.length / 2)]!;
const names = [...new Set(rows.map((r) => r.name))];

const result: Record<string, { label: string; peakMiB: number; scenarios: Record<string, { rps: number; p50ms: number; p99ms: number; cores: number; success: number }> }> = {};
for (const name of names) {
  const scenarios: Record<string, { rps: number; p50ms: number; p99ms: number; cores: number; success: number }> = {};
  for (const s of SCENARIOS) {
    const runs = rows.filter((r) => r.name === name && r.scenario === s);
    if (!runs.length) continue;
    const m = median(runs);
    scenarios[s] = { rps: Math.round(m.rps!), p50ms: +m.p50ms!.toFixed(3), p99ms: +m.p99ms!.toFixed(3), cores: +m.cores!.toFixed(2), success: m.success! };
  }
  result[name] = { label: LABELS[name] ?? name, peakMiB: rows.find((r) => r.name === name && r.scenario === "_memory")?.peakMiB ?? 0, scenarios };
}
writeFileSync(`${import.meta.dir}/results.json`, `${JSON.stringify(result, null, 2)}\n`);

const k = (n: number) => n.toLocaleString("en-US");
const ordered = names.slice().sort((a, b) => (result[b]!.scenarios.read?.rps ?? 0) - (result[a]!.scenarios.read?.rps ?? 0));
let md = "| Server | Read | List (20) | Update | Create | Peak memory |\n|---|---:|---:|---:|---:|---:|\n";
for (const n of ordered) md += `| ${result[n]!.label} | ${SCENARIOS.map((s) => (result[n]!.scenarios[s] ? k(result[n]!.scenarios[s]!.rps) : "")).join(" | ")} | ${result[n]!.peakMiB} MiB |\n`;
md += "\nRequests per second, median of the runs. Latency (p50 / p99, ms) and the CPU the server used:\n\n| Server | Scenario | p50 | p99 | Cores used |\n|---|---|---:|---:|---:|\n";
for (const n of ordered) for (const s of SCENARIOS) if (result[n]!.scenarios[s]) md += `| ${result[n]!.label} | ${s} | ${result[n]!.scenarios[s]!.p50ms} | ${result[n]!.scenarios[s]!.p99ms} | ${result[n]!.scenarios[s]!.cores} |\n`;
writeFileSync(`${import.meta.dir}/results.md`, md);
console.log(md);
