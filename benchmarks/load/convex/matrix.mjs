#!/usr/bin/env node
// Convex's local backend and archlast-forge on one workload, one machine, one load generator. See ../convex-vs-forge.md.
//
//   node matrix.mjs [--runs 3] [--seconds 15] [--configs id,id] [--cases A,B,...] [--out results/x.jsonl] [--list]
//
// For every run and every config: start the system on fresh data (64 lists x 20 todos = 1,280 todos), check the seed, run the cases, check
// the data afterwards (queries return 20 rows of the right list; every insert and every toggle is there), stop it, write one JSON line per case.
// Cores: server and load generator are pinned with taskset, the database container with `docker update --cpuset-cpus` (see CORES).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOAD = join(HERE, "..");
const ROOT = join(HERE, "../../..");
const CACHE = process.env.BENCH_HOME ?? join(process.env.HOME, ".cache/bench");
const CONVEX_BIN = join(CACHE, "bin/convex-local-backend");
const SECRET = readFileSync(join(CACHE, "convex-secret"), "utf8").trim();
const INSTANCE = "convex-self-hosted"; // the name the self-hosted docs use; Postgres/MySQL take their database name from it
const KEY = "bench-admin-key-0123456789abcdef0123";

const args = {};
for (const [i, a] of process.argv.slice(2).entries()) if (a.startsWith("--")) { const n = process.argv[i + 3]; args[a.slice(2)] = n === undefined || n.startsWith("--") ? "1" : n; }
const RUNS = Number(args.runs ?? 3);
const SECONDS = Number(args.seconds ?? 15);
const WARM = Number(args.warm ?? 4);
const OUT = args.out ?? join(HERE, "results/results.jsonl");
const LOGS = join(dirname(OUT), "logs");
mkdirSync(LOGS, { recursive: true });

// CPUs (not hyperthreads: the siblings of 2-5 are 10-13, left idle). Embedded databases share the three database+server cores.
const CORES = { embedded: process.env.CORES_EMBEDDED ?? "2-4", server: process.env.CORES_SERVER ?? "2-3", db: process.env.CORES_DB ?? "4", load: process.env.CORES_LOAD ?? "5" };
const PG = "archlast-forge-postgres-1";
const MONGO = "archlast-forge-mongo-1";
const PGURL = "postgres://forge:forge@localhost:55432/forge";
const CONVEX_PGURL = "postgresql://forge:forge@localhost:55432";
const MONGOURL = "mongodb://localhost:57017/forge?replicaSet=rs0&directConnection=true";
const DATA = process.env.DATA_ROOT ?? join(CACHE, "data");

// What "optimized" means for each, and why, is written up in convex-vs-forge.md ("How each system was configured").
const CONVEX_OPT = { APPLICATION_MAX_CONCURRENT_QUERIES: "64", APPLICATION_MAX_CONCURRENT_MUTATIONS: "64", RUST_LOG: "warn" };
const PG_TUNED = { shared_buffers: "'1GB'", effective_cache_size: "'4GB'", random_page_cost: "1.1", jit: "off", wal_compression: "on", max_connections: "200" };

const CONFIGS = [
  { id: "forge-sqlite-default", sys: "forge", db: "sqlite", env: {} },
  { id: "forge-sqlite-normal", sys: "forge", db: "sqlite", env: { SQLITE_SYNCHRONOUS: "NORMAL" } },
  { id: "forge-sqlite-w2", sys: "forge", db: "sqlite", env: { RUNTIME_WORKERS: "2" } },
  { id: "forge-postgres-default", sys: "forge", db: "postgres", env: { DATABASE_URL: PGURL } },
  { id: "forge-postgres-w2-tuned", sys: "forge", db: "postgres", pgTuned: true, env: { DATABASE_URL: PGURL, RUNTIME_WORKERS: "2" } },
  { id: "forge-mongodb-default", sys: "forge", db: "mongodb", env: { DATABASE_URL: MONGOURL } },
  { id: "forge-mongodb-w2", sys: "forge", db: "mongodb", env: { DATABASE_URL: MONGOURL, RUNTIME_WORKERS: "2" } },
  { id: "forge-mongodb-w2-w1nojournal", sys: "forge", db: "mongodb", env: { DATABASE_URL: MONGOURL + "&w=1&journal=false", RUNTIME_WORKERS: "2" } },
  { id: "convex-sqlite-default", sys: "convex", db: "sqlite", env: {} },
  { id: "convex-sqlite-opt", sys: "convex", db: "sqlite", env: CONVEX_OPT },
  { id: "convex-postgres-default", sys: "convex", db: "postgres", env: {} },
  { id: "convex-postgres-opt-tuned", sys: "convex", db: "postgres", pgTuned: true, env: CONVEX_OPT },
  { id: "control", sys: "control", db: "none", env: {} },
];
if (args.list) (console.log(CONFIGS.map((c) => c.id).join("\n")), process.exit(0));
const pick = args.configs ? args.configs.split(",") : CONFIGS.filter((c) => c.sys !== "control" || args.control).map((c) => c.id);
const wantCase = args.cases ? new Set(args.cases.split(",")) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: "utf8", ...o });
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- databases
function docker(...a) {
  const r = sh("docker", a);
  if (r.status !== 0) throw new Error(`docker ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function psql(sql, db = "forge") {
  return docker("exec", PG, "psql", "-U", "forge", "-d", db, "-qAtc", sql);
}
async function prepareDb(cfg, fresh) {
  if (cfg.db === "postgres") {
    docker("update", "--cpuset-cpus", CORES.db, PG);
    if (fresh.pgConfigured !== !!cfg.pgTuned) {
      psql("alter system reset all", "postgres");
      if (cfg.pgTuned) for (const [k, v] of Object.entries(PG_TUNED)) psql(`alter system set ${k}=${v}`, "postgres");
      docker("restart", PG);
      for (let i = 0; i < 60; i++) { if (sh("docker", ["exec", PG, "pg_isready", "-U", "forge"]).status === 0) break; await sleep(500); }
      fresh.pgConfigured = !!cfg.pgTuned;
    }
    if (cfg.sys === "forge") psql("drop schema public cascade; create schema public");
    else {
      psql("drop database if exists convex_self_hosted with (force)", "postgres");
      psql("create database convex_self_hosted", "postgres");
    }
  } else if (cfg.db === "mongodb") {
    docker("update", "--cpuset-cpus", CORES.db, MONGO);
    docker("exec", MONGO, "mongosh", "--quiet", "--eval", 'db.getSiblingDB("forge").dropDatabase()');
  }
}
function releaseDb() {
  for (const c of [PG, MONGO]) sh("docker", ["update", "--cpuset-cpus", "0-15", c]);
}

// A Convex backend logs every request at its default level (tens of MB a run): keep the first and last lines and say how many there were.
function trimLog(file) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.length < 400) return;
    writeFileSync(file, [...lines.slice(0, 150), `... ${lines.length - 300} lines omitted (of ${lines.length}) ...`, ...lines.slice(-150)].join("\n"));
  } catch {}
}

// ---------------------------------------------------------------- systems
class System {
  constructor(cfg, phaseEnv, runTag) {
    this.cfg = cfg;
    this.phaseEnv = phaseEnv;
    this.tag = `${cfg.id}.${runTag}`;
    this.port = cfg.sys === "forge" ? 3100 : cfg.sys === "convex" ? 3210 : 3100;
    this.base = `http://127.0.0.1:${this.port}`;
    this.logFile = join(LOGS, `${this.tag}.log`);
    this.dir = join(DATA, cfg.id);
    this.lists = [];
    this.todos = [];
    this.inserted = new Array(64).fill(0); // todos added by C beyond the seed, per list
    this.toggles = new Array(1280).fill(0);
  }
  cores() { return this.cfg.db === "sqlite" ? CORES.embedded : CORES.server; }
  async start() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    const out = (await import("node:fs")).openSync(this.logFile, "w");
    const env = { ...process.env, ...this.cfg.env, ...this.phaseEnv };
    if (this.cfg.sys === "forge") {
      env.PORT = String(this.port);
      env.DATA_DIR = this.dir;
      env.SEED_LISTS = "64";
      env.LIST_FILE = join(this.dir, "lists");
      this.proc = spawn("taskset", ["-c", this.cores(), "bun", join(LOAD, "serve.ts")], { env, stdio: ["ignore", out, out] });
      for (let i = 0; i < 480; i++) {
        if (readFileSync(this.logFile, "utf8").includes("READY")) break;
        if (this.proc.exitCode !== null) throw new Error("forge exited: " + readFileSync(this.logFile, "utf8").slice(-500));
        await sleep(250);
      }
      if (!readFileSync(this.logFile, "utf8").includes("READY")) throw new Error("forge did not start");
      this.lists = readFileSync(env.LIST_FILE, "utf8").trim().split("\n");
      this.todos = readFileSync(env.LIST_FILE + ".todos", "utf8").trim().split("\n");
    } else {
      const db = this.cfg.db === "sqlite" ? ["--db", "sqlite", join(this.dir, "db.sqlite3")] : ["--db", "postgres-v5", CONVEX_PGURL, "--do-not-require-ssl"];
      this.proc = spawn("taskset", ["-c", this.cores(), CONVEX_BIN, "--instance-name", INSTANCE, "--instance-secret", SECRET, "--disable-beacon", ...db, "--local-storage", join(this.dir, "storage")], { env, cwd: this.dir, stdio: ["ignore", out, out] });
      for (let i = 0; i < 240; i++) {
        try { if ((await fetch(this.base + "/version")).ok) break; } catch {}
        if (this.proc.exitCode !== null) throw new Error("convex exited: " + readFileSync(this.logFile, "utf8").slice(-500));
        await sleep(250);
      }
      const adminKey = execFileSync(CONVEX_BIN, ["keygen", "admin-key", "--instance-name", INSTANCE, "--instance-secret", SECRET], { encoding: "utf8" }).trim();
      const d = sh("npx", ["convex", "deploy", "--yes"], { cwd: HERE, env: { ...process.env, CONVEX_SELF_HOSTED_URL: this.base, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey, CONVEX_TMPDIR: this.dir } });
      if (d.status !== 0) throw new Error("convex deploy failed: " + d.stdout + d.stderr);
      await sleep(1000);
      // seed: 64 lists x 20 todos, in the order serve.ts adds them
      for (let l = 0; l < 64; l++) {
        const id = await this.mutate("todos:createList", { name: `bench ${l}` });
        for (let i = 0; i < 20; i++) this.todos.push(await this.mutate("todos:add", { listId: id, title: `todo ${i}` }));
        this.lists.push(id);
      }
    }
    this.todoIndex = new Map(this.todos.map((id, i) => [id, i]));
  }
  async stop() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    p.on("exit", () => trimLog(this.logFile));
    p.kill("SIGTERM");
    await new Promise((r) => {
      const t = setTimeout(() => (p.kill("SIGKILL"), r()), 8000);
      p.on("exit", () => (clearTimeout(t), r()));
    });
  }
  async mutate(path, a) {
    const r = this.cfg.sys === "forge"
      ? await (await fetch(`${this.base}/rpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) })).json()
      : await (await fetch(`${this.base}/api/mutation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args: a, format: "json" }) })).json();
    if (this.cfg.sys === "convex" ? r.status !== "success" : !("result" in r)) throw new Error(`${path} failed: ${JSON.stringify(r)}`);
    return this.cfg.sys === "convex" ? r.value : r.result;
  }
  async query(path, a) {
    if (this.cfg.sys === "forge") {
      const r = await (await fetch(`${this.base}/rpc/${path}?args=${encodeURIComponent(JSON.stringify(a))}`)).json();
      return r.result;
    }
    const r = await (await fetch(`${this.base}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args: a, format: "json" }) })).json();
    if (r.status !== "success") throw new Error(JSON.stringify(r));
    return r.value;
  }
  /** Reads every list back and compares with what the cases should have done. Returns a list of problems (empty = fine). */
  async verify() {
    const bad = [];
    const done = new Array(1280).fill(null);
    for (let l = 0; l < 64; l++) {
      const rows = await this.query("todos:listByList", { listId: this.lists[l] });
      const want = 20 + this.inserted[l];
      if (rows.length !== want) bad.push(`list ${l}: ${rows.length} rows, expected ${want}`);
      for (const r of rows) {
        if (r.listId !== this.lists[l]) bad.push(`list ${l}: row of list ${r.listId}`);
        const i = this.todoIndex.get(r._id);
        if (i !== undefined) done[i] = r.done;
      }
    }
    for (let i = 0; i < 1280; i++) if (done[i] !== this.toggles[i] % 2 === 1) bad.push(`todo ${i}: done=${done[i]}, toggled ${this.toggles[i]} times`);
    return bad.slice(0, 5);
  }
}

// ---------------------------------------------------------------- cases
const cpu = () => Object.fromEntries(readFileSync("/proc/stat", "utf8").split("\n").filter((l) => /^cpu\d/.test(l)).map((l) => { const f = l.split(/\s+/); const n = f.slice(1).map(Number); const busy = n[0] + n[1] + n[2] + n[5] + n[6] + n[7]; return [f[0], [busy, busy + n[3] + n[4]]]; }));
const busy = (a, b) => Object.keys(b).filter((k) => ["cpu2", "cpu3", "cpu4", "cpu5"].includes(k)).map((k) => `${k}:${Math.round((100 * (b[k][0] - a[k][0])) / (b[k][1] - a[k][1]))}`).join(",");

function loadEnv(sys, kind) {
  const L = sys.lists[0];
  const forge = sys.cfg.sys !== "convex";
  const q = (name, id) => `/rpc/${name}?args=${encodeURIComponent(JSON.stringify({ listId: id }))}`;
  switch (kind) {
    case "A": return forge ? { REQ_PATH: q("todos:listByList", L), OK_BODY: '"result":[{' } : post("/api/query", { path: "todos:listByList", args: { listId: "{id}" }, format: "json" }, [L], '"value":[{');
    case "B": return forge ? { REQ_PATHS: JSON.stringify(sys.lists.map((id) => q("todos:listByList", id))), OK_BODY: '"result":[{' } : post("/api/query", { path: "todos:listByList", args: { listId: "{id}" }, format: "json" }, sys.lists, '"value":[{');
    case "Bnc": {
      // a nonce that is unique within and across invocations: a random prefix, then the request counter's digits
      const base = String(1000 + Math.floor(Math.random() * 8999));
      const e = post("/api/query", { path: "todos:listByListNoCache", args: { listId: "{id}", nonce: 0 }, format: "json" }, sys.lists, '"value":[{');
      e.BODY = e.BODY.replace('"nonce":0', `"nonce":${base}{n}`);
      return e;
    }
    case "C": return forge ? { POST_PATH: "/rpc/todos:add", BODY: JSON.stringify({ listId: "{id}", title: "t {n}" }), BODY_IDS: JSON.stringify(sys.lists), OK_BODY: '"result"' } : post("/api/mutation", { path: "todos:add", args: { listId: "{id}", title: "t {n}" }, format: "json" }, sys.lists, '"status":"success"');
    case "D": return forge ? { POST_PATH: "/rpc/todos:toggle", BODY: '{"id":"{id}"}', BODY_IDS: JSON.stringify(sys.todos), OK_BODY: '"result"' } : post("/api/mutation", { path: "todos:toggle", args: { id: "{id}" }, format: "json" }, sys.todos, '"status":"success"');
  }
}
function post(path, body, ids, ok) {
  return { POST_PATH: path, BODY: JSON.stringify(body), ...(ids ? { BODY_IDS: JSON.stringify(ids) } : {}), OK_BODY: ok };
}
function runLoad(sys, kind, seconds, rate) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORTS: String(sys.port), CONNS: "64", SECONDS: String(seconds), RATE: rate ? String(rate) : "", ...loadEnv(sys, kind) };
    const p = spawn("taskset", ["-c", CORES.load, "node", join(LOAD, "load.mjs")], { env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { reject(new Error("load output: " + out.slice(-300))); } });
  });
}
function fanout(sys, c) {
  return new Promise((resolve, reject) => {
    const forge = sys.cfg.sys !== "convex";
    const env = { ...process.env, PORT: String(sys.port), SECONDS: String(SECONDS), CLIENTS: "1000", RATE: "10" };
    // E: archlast-forge's own fanout.ts, and the Convex port of it. Eu: the Convex port's client code run against archlast-forge too.
    const p = forge && c === "E" ? spawn("taskset", ["-c", CORES.load, "bun", join(LOAD, "fanout.ts")], { env }) : spawn("taskset", ["-c", CORES.load, "node", join(HERE, "fanout-convex.mjs")], { env: { ...env, CONVEX_URL: sys.base, SYSTEM: forge ? "forge" : "convex" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { reject(new Error("fanout output: " + out.slice(-400))); } });
  });
}

const OPEN = { A: 2000, B: 2000, Bnc: 2000, C: 500, D: 500 };
// phases: cases that share one server start. Forge's cache TTL is an engine setting, so B and E run on a server started with CACHE_TTL_MS=0.
const PHASES = {
  forge: [
    { env: {}, cases: ["A", "Aopen", "D", "Dopen", "C", "Copen"] },
    { env: { CACHE_TTL_MS: "0" }, cases: ["B", "Bopen"] },
    { env: { CACHE_TTL_MS: "0" }, cases: ["E", "Eu"] },
  ],
  convex: [
    { env: {}, cases: ["A", "Aopen", "B", "Bopen", "Bnc", "Bncopen", "D", "Dopen", "C", "Copen"] },
    { env: {}, cases: ["E"] },
  ],
};

async function runCase(sys, c, cpuBefore) {
  const rec = { config: sys.cfg.id, system: sys.cfg.sys, db: sys.cfg.db, case: c };
  if (c === "E" || c === "Eu") {
    const c0 = cpu();
    const f = await fanout(sys, c);
    return { ...rec, ...f, cpu: busy(c0, cpu()), verifyProblems: [] };
  }
  const kind = c.replace(/open$/, "");
  const rate = c.endsWith("open") ? OPEN[kind] : 0;
  const warm = await runLoad(sys, kind, WARM, rate);
  const c0 = cpu();
  const t0 = Date.now();
  const r = await runLoad(sys, kind, SECONDS, rate);
  const c1 = cpu();
  // book-keeping for the data check: every answered request of C inserted a row, every one of D toggled the next todo
  for (const x of [warm, r]) {
    const ok = x.requests - x.non2xx;
    if (kind === "C") for (let i = 0; i < ok; i++) sys.inserted[i % 64]++;
    if (kind === "D") for (let i = 0; i < x.requests; i++) if (i < ok) sys.toggles[i % 1280]++;
  }
  return { ...rec, rate: rate || null, load: r, warm: { requests: warm.requests, non2xx: warm.non2xx }, cpu: busy(c0, c1), seconds: (Date.now() - t0) / 1000 };
}

async function main() {
  const pgState = { pgConfigured: null };
  const machine = { loadavg: readFileSync("/proc/loadavg", "utf8").trim() };
  log("start", { runs: RUNS, seconds: SECONDS, configs: pick, out: OUT });
  for (let run = 1; run <= RUNS; run++) {
    for (const id of pick) {
      const cfg = CONFIGS.find((c) => c.id === id);
      if (!cfg) throw new Error("unknown config " + id);
      if (cfg.sys === "control") { await controlRun(run); continue; }
      const phases = PHASES[cfg.sys];
      for (let pi = 0; pi < phases.length; pi++) {
        const ph = phases[pi];
        const cases = ph.cases.filter((c) => !wantCase || wantCase.has(c));
        if (!cases.length) continue;
        let sys;
        try {
          await prepareDb(cfg, pgState);
          sys = new System(cfg, ph.env, `r${run}p${pi}`);
          await sys.start();
          const pre = await sys.verify();
          for (const c of cases) {
            let rec;
            try {
              log(`run ${run}  ${id}  ${c}`);
              rec = await runCase(sys, c);
              rec.verifyProblems = c === "E" ? [] : await sys.verify();
              rec.run = run;
              rec.preVerify = pre;
              rec.discard = !!(rec.verifyProblems.length || pre.length || (rec.load && rec.load.non2xx));
              if (c === "E" || c === "Eu") rec.discard = rec.missing !== undefined ? rec.missing > 0 : rec.updates !== rec.expected;
            } catch (e) {
              rec = { config: id, case: c, run, error: String(e.message ?? e), discard: true };
            }
            appendFileSync(OUT, JSON.stringify({ ...rec, at: new Date().toISOString(), loadavg: readFileSync("/proc/loadavg", "utf8").trim().split(" ")[0] }) + "\n");
            log("   ", rec.error ?? (rec.load ? `${rec.load.rps} req/s p50 ${rec.load.p50} p99 ${rec.load.p99} bad ${rec.load.non2xx}${rec.discard ? " DISCARD " + JSON.stringify(rec.verifyProblems) : ""}` : `p50 ${rec.p50} p99 ${rec.p99} ${rec.updates}/${rec.expected} missing ${rec.missing} settle ${rec.settleMs}`));
          }
        } catch (e) {
          appendFileSync(OUT, JSON.stringify({ config: id, run, phase: pi, error: String(e.message ?? e), discard: true, at: new Date().toISOString() }) + "\n");
          log("ERROR", id, e.message);
        } finally {
          if (sys) await sys.stop();
        }
      }
    }
  }
  releaseDb();
}

async function controlRun(run) {
  // control.ts: Bun.serve with a fixed 20-document body, on the server cores; the same load generator and rates
  const p = spawn("taskset", ["-c", CORES.server, "bun", join(LOAD, "control.ts")], { env: { ...process.env, PORT: "3100" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => p.stdout.on("data", (d) => String(d).includes("READY") && r()));
  const sys = { port: 3100, lists: [], todos: [], cfg: { sys: "forge" } };
  const mk = (extra) => ({ ...process.env, PORTS: "3100", CONNS: "64", SECONDS: String(SECONDS), REQ_PATH: "/", OK_BODY: '"result"', ...extra });
  for (const [name, extra] of [["closed", { RATE: "" }], ["open2000", { RATE: "2000" }]]) {
    await new Promise((resolve) => { const l = spawn("taskset", ["-c", CORES.load, "node", join(LOAD, "load.mjs")], { env: mk(extra) }); l.stdout.on("data", () => {}); l.on("close", resolve); });
    const c0 = cpu();
    const out = await new Promise((resolve) => { let o = ""; const l = spawn("taskset", ["-c", CORES.load, "node", join(LOAD, "load.mjs")], { env: mk(extra) }); l.stdout.on("data", (d) => (o += d)); l.on("close", () => resolve(o)); });
    const rec = { config: "control", case: name, run, load: JSON.parse(out.trim().split("\n").pop()), cpu: busy(c0, cpu()), at: new Date().toISOString(), loadavg: readFileSync("/proc/loadavg", "utf8").trim().split(" ")[0] };
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    log("control", name, rec.load.rps, rec.load.p50, rec.load.p99);
  }
  p.kill("SIGTERM");
  await sleep(500);
}

await main();
log("finished");
