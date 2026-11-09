// Writes the benchmark tables into the docs pages from apps/docs/src/bench.json, between {/* bench:<name> */} and {/* /bench:<name> */}, so the numbers on the pages
// are the ones that were measured:  bun benchmarks/docs.ts   (after collect.ts)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const dir = `${import.meta.dir}/../apps/docs`;
const b = JSON.parse(readFileSync(`${dir}/src/bench.json`, "utf8"));
const k = (n: number) => Math.round(n).toLocaleString("en-US");
const ms = (n: number) => (n >= 100 ? k(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const times = (a: number, c: number) => (a / c >= 10 ? Math.round(a / c) : (a / c).toFixed(1)) + "×";

const SCEN = ["read", "list", "update", "create"] as const;
const rest = b.rest as Record<string, { label: string; peakMiB: number; scenarios: Record<string, { rps: number; p50ms: number; p99ms: number; cores: number }> }>;

const blocks: Record<string, string> = {};

blocks.machine = `| | |
|---|---|
| CPU | ${b.machine.cpu}: ${b.machine.cores} cores, ${b.machine.threads} threads (governor \`${b.machine.governor}\`, boost on) |
| Memory | ${b.machine.memoryGiB} GiB |
| OS | Linux ${b.machine.kernel}, Docker ${b.machine.docker} |
| Server limits | **4 CPU cores** (\`--cpuset-cpus=${b.limits.serverCpus}\`, the first thread of four physical cores) and **${b.limits.serverMemory} of memory** with no swap (\`--memory=2g --memory-swap=2g\`) |
| Load | [oha](https://github.com/hatoo/oha) ${b.machine.oha} on 4 other threads (\`${b.limits.clientCpus}\`, the first thread of four other physical cores), ${b.limits.connections} connections, outside the server's container |
| Runs | 2 s warm-up, then 3 runs of ${b.limits.secs} s per case; the median is reported |`;

const ordered = Object.entries(rest).sort((a, c) => (c[1].scenarios.read?.rps ?? 0) - (a[1].scenarios.read?.rps ?? 0));
blocks.rest = `| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
${ordered.map(([, r]) => `| ${r.label} | ${SCEN.map((s) => k(r.scenarios[s]!.rps)).join(" | ")} | ${r.peakMiB} MiB |`).join("\n")}

Requests per second. Latency in milliseconds (p50 / p99) for the read case: ${ordered.map(([, r]) => `${r.label.replace(/ \(.*/, "")} ${ms(r.scenarios.read!.p50ms)} / ${ms(r.scenarios.read!.p99ms)}`).join("; ")}.`;

const restSqlite = b.restSqlite as typeof rest;
const orderedSqlite = Object.entries(restSqlite).sort((a, c) => (c[1].scenarios.read?.rps ?? 0) - (a[1].scenarios.read?.rps ?? 0));
blocks["rest-sqlite"] = `| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
${orderedSqlite.map(([, r]) => `| ${r.label} | ${SCEN.map((s) => k(r.scenarios[s]!.rps)).join(" | ")} | ${r.peakMiB} MiB |`).join("\n")}

Requests per second. Latency in milliseconds (p50 / p99) for the read case: ${orderedSqlite.map(([, r]) => `${r.label.replace(/ \(.*/, "")} ${ms(r.scenarios.read!.p50ms)} / ${ms(r.scenarios.read!.p99ms)}`).join("; ")}.`;

const fa = rest.forge!, fb = rest["forge-bun"]!;
blocks.engine = `| | \`Bun.serve\` | Tuyere | |
|---|---:|---:|---:|
${SCEN.map((s) => `| ${{ read: "Read one item", list: "List 20 items", update: "Update an item", create: "Create an item" }[s]} (requests/s) | ${k(fb.scenarios[s]!.rps)} | ${k(fa.scenarios[s]!.rps)} | ${times(fa.scenarios[s]!.rps, fb.scenarios[s]!.rps)} |`).join("\n")}
| Read, 99th percentile | ${ms(fb.scenarios.read!.p99ms)} ms | ${ms(fa.scenarios.read!.p99ms)} ms | |`;

const p = b.pool;
blocks.pool = `| | requests/s | p50 | p99 | CPU cores used |
|---|---:|---:|---:|---:|
| The work on the serving thread | ${k(p.inlineWork.rps)} | ${ms(p.inlineWork.p50ms)} ms | ${ms(p.inlineWork.p99ms)} ms | ${p.inlineWork.cores} |
| The work in Anvil (3 workers) | **${k(p.poolWork.rps)}** (${times(p.poolWork.rps, p.inlineWork.rps)}) | ${ms(p.poolWork.p50ms)} ms | ${ms(p.poolWork.p99ms)} ms | ${p.poolWork.cores} |

\`/ping\` (does nothing), measured while the work route is under load from ${p.params.conns} connections:

| | requests/s | p50 | p99 |
|---|---:|---:|---:|
| Idle server | ${k(p.pingIdle.rps)} | ${ms(p.pingIdle.p50ms)} ms | ${ms(p.pingIdle.p99ms)} ms |
| Work on the serving thread | ${k(p.pingInline.rps)} | ${ms(p.pingInline.p50ms)} ms | ${ms(p.pingInline.p99ms)} ms |
| Work in Anvil | **${k(p.pingPool.rps)}** | ${ms(p.pingPool.p50ms)} ms | ${ms(p.pingPool.p99ms)} ms |`;

const fs = b.fullstack as Record<string, Record<string, Record<string, { rps: number; p50ms: number; p99ms: number; peakMiB: number; htmlKB: number; jsGzKB: number }>>>;
const order = (rows: Record<string, { rps: number }>) => Object.entries(rows).sort((a, c) => c[1].rps - a[1].rps);
const table = (rows: Record<string, { rps: number; p50ms: number; p99ms: number; peakMiB: number; htmlKB: number; jsGzKB: number }>) =>
  `| | requests/s | p50 | p99 | Peak memory | HTML | JavaScript sent (gzip) |
|---|---:|---:|---:|---:|---:|---:|
${order(rows).map(([name, r]) => `| ${name} | ${k(r.rps)} | ${ms(r.p50ms)} ms | ${ms(r.p99ms)} ms | ${r.peakMiB} MiB | ${r.htmlKB} KB | ${r.jsGzKB} KB |`).join("\n")}`;
blocks["fullstack-home"] = table(fs.perCall!["/"]!);
blocks["fullstack-products"] = table(fs.shared!["/products"]!);
blocks["fullstack-products-percall"] = table(fs.perCall!["/products"]!);

const v = b.versions;
blocks.versions = `Express ${v.express} on Node ${v.node}; Bun ${v.bun}; Go ${v.go} with fasthttp ${v.fasthttp}; .NET ${v.dotnet} (Minimal APIs); Rust ${v.rust} with Axum ${v.axum}. The full-stack apps ran on Node ${v.nodeForFullstack}: React Router ${v.reactRouter}, Next.js ${v.next}, brust ${v.brust}.`;

blocks["sqlite-versions"] = "SQLite " + v.sqlite + " is the version in Bun 1.4 (which `bun:sqlite` and the engine use); `rusqlite` and `go-sqlite3` compile their own copy, Node's `node:sqlite` and .NET's `Microsoft.Data.Sqlite` bring theirs.";

let changed = 0;
for (const file of readdirSync(`${dir}/content`).filter((f) => f.endsWith(".mdx"))) {
  const path = `${dir}/content/${file}`;
  const before = readFileSync(path, "utf8");
  const after = before.replace(/\{\/\* bench:([\w-]+) \*\/\}[\s\S]*?\{\/\* \/bench:\1 \*\/\}/g, (_, name: string) => {
    if (!(name in blocks)) throw new Error(`${file}: no benchmark block called ${name}`);
    return `{/* bench:${name} */}\n\n${blocks[name]}\n\n{/* /bench:${name} */}`;
  });
  if (after !== before) (writeFileSync(path, after), changed++, console.log(`updated ${file}`));
}
console.log(`${changed} pages`);
