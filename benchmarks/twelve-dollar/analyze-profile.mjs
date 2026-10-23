#!/usr/bin/env node
// Summarizes Bun/Chrome .cpuprofile files: where the CPU time went, by function and by area.
//   node analyze-profile.mjs <dir with .cpuprofile files> [top N]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const TOP = Number(process.argv[3] ?? 25);
const area = (url, fn) => {
  if (!url) return fn?.startsWith("(") ? `engine: ${fn}` : "native / runtime internals";
  if (url.includes("better-auth") || url.includes("better-call") || url.includes("@better-auth")) return "Better Auth";
  if (url.includes("node_modules/zod") || url.includes("/zod/")) return "zod (argument validation)";
  if (url.includes("rpc.ts")) return "RPC";
  if (url.includes("/db/sqlite") || url.includes("/db/turso")) return "database adapter (driver calls)";
  if (url.includes("docstore")) return "document store (SQL building, JSON parse)";
  if (url.includes("admin-ops") && /LogWriter|flush/.test(fn)) return "log persistence (_logs inserts)";
  if (url.includes("executor")) return "executor (call path, logging)";
  if (url.includes("runtime.ts")) return "server <-> runtime IPC";
  if (url.includes("server/server.ts") || url.includes("admin-api") || url.includes("protocol")) return "HTTP server + routing";
  if (url.includes("/forge/")) return "your functions (feed.ts)";
  if (url.includes("subscriptions") || url.includes("cache.ts")) return "query cache / subscriptions";
  if (url.startsWith("node:") || url.startsWith("bun:")) return `built-ins (${url.split(":")[0]})`;
  return "other: " + url.replace(/^.*node_modules\//, "").split("/").slice(0, 2).join("/");
};

for (const file of readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"))) {
  const p = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(); // node id -> microseconds
  p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const frame = (id) => byId.get(id).callFrame;
  // A native frame (send, all, run, parse, stringify...) belongs to the JavaScript that called it: walk up to the nearest frame with a source URL.
  // A stack with no JavaScript in it at all is the event loop waiting (or the runtime's own work between callbacks): idle.
  const owner = (id) => {
    for (let x = id; x !== undefined; x = parent.get(x)) if (frame(x).url) return frame(x);
    return undefined;
  };
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  let idle = 0;
  const fns = new Map();
  const areas = new Map();
  const natives = new Map();
  for (const [id, us] of self) {
    const f = frame(id);
    const o = owner(id);
    if (!o) {
      idle += us;
      continue;
    }
    const key = `${f.functionName || "(anonymous)"}  ${f.url ? f.url.replace(/^.*\/(packages|node_modules)\//, "$1/") + ":" + (f.lineNumber + 1) : "[native, called from " + (o.functionName || "(anon)") + " " + o.url.replace(/^.*\/(packages|node_modules)\//, "$1/") + ":" + (o.lineNumber + 1) + "]"}`;
    fns.set(key, (fns.get(key) ?? 0) + us);
    const a = area(o.url, o.functionName);
    areas.set(a, (areas.get(a) ?? 0) + us);
    if (!f.url) natives.set(f.functionName || "(anonymous)", (natives.get(f.functionName || "(anonymous)") ?? 0) + us);
  }
  const busy = total - idle;
  const pct = (us) => `${((us / busy) * 100).toFixed(1).padStart(5)}%`;
  console.log(`\n=== ${file}: ${(total / 1e6).toFixed(0)} s sampled; ${(idle / 1e6).toFixed(0)} s idle in the event loop; ${(busy / 1e6).toFixed(0)} s of work (shares below are of that work)`);
  console.log("-- by area (JavaScript that was on the stack, native calls included)");
  for (const [a, us] of [...areas].sort((x, y) => y[1] - x[1]).slice(0, 14)) console.log(`${pct(us)}  ${a}`);
  console.log(`-- top ${TOP} frames by self time`);
  for (const [k, us] of [...fns].sort((x, y) => y[1] - x[1]).slice(0, TOP)) console.log(`${pct(us)}  ${(us / 1000).toFixed(0).padStart(7)} ms  ${k}`);
}
