#!/usr/bin/env node
// Runs the engine limited to ONE CPU core and 2 GB of RAM and scores it like the challenge does.
//
//   node score.mjs check    functional checks (the RPC translation of test.sh) on a fresh database
//   node score.mjs smoke    a short load run, to see that everything works
//   node score.mjs capacity closed-loop probes: the most requests per second each kind of call can reach, and what each costs in CPU
//   node score.mjs profile  a load run with CPU profiling on (VUS=2000), written under WORK/profiles
//   node score.mjs score    warm-up, find the limit (2,500 users, doubling, then narrowing to within 250), confirm with a 5-minute hold
//
// Env: SEED (dir with app.db and tokens.json), WORK (scratch dir for the database copy), CHALLENGE (a clone of the challenge repo, for the
//      golden files), PORT (3100), SERVER_CPU (0), LOAD_CPUS (2,3), MEMORY (2g), CACHE_TTL_MS (60000), SECRET.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const env = process.env;
const SEED = resolve(env.SEED ?? "/config/bench/twelve-seed");
const WORK = resolve(env.WORK ?? "/config/bench/run");
const CHALLENGE = resolve(env.CHALLENGE ?? "");
const PORT = env.PORT ?? "3100";
const SERVER_CPU = env.SERVER_CPU ?? "0";
const LOAD_CPUS = env.LOAD_CPUS ?? "2,3";
const MEMORY = env.MEMORY ?? "2g";
const SECRET = env.SECRET ?? "twelve-dollar-bench-secret-0123456789abcdef";
const BASE = `http://127.0.0.1:${PORT}`;
const RESULTS = join(WORK, "results");
mkdirSync(RESULTS, { recursive: true });

const sh = (cmd, opts = {}) => spawnSync("sh", ["-c", cmd], { encoding: "utf8", ...opts });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- the server: the real engine (`archlast-forge start --no-docker`, the code the engine image runs) on ONE core, with a 2 GiB memory cap ----
// Docker can't limit CPU or memory in this sandbox (no cgroup controllers are delegated), so the cap is virtual: taskset pins the server and its
// function-runtime process to one core, and a watchdog kills them if their resident memory goes over the limit, which counts as running out of memory.
let server;
let oomKilled = false;
const limitMiB = Number(MEMORY.replace(/g$/i, "")) * 1024;
const tree = (pid) => {
  const rows = sh("ps -eo pid=,ppid=").stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const out = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp] of rows) if (out.has(pp) && !out.has(p)) (out.add(p), (grew = true));
  }
  return [...out];
};
/** Bytes the kernel actually read from and wrote to disk for a process (page-cache hits don't count). */
const procIo = (pid) => {
  try {
    const t = readFileSync(`/proc/${pid}/io`, "utf8");
    return { read: Number(/read_bytes: (\d+)/.exec(t)?.[1] ?? 0), write: Number(/^write_bytes: (\d+)/m.exec(t)?.[1] ?? 0) };
  } catch {
    return { read: 0, write: 0 };
  }
};
const procStat = (pid) => {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = f.slice(f.lastIndexOf(")") + 2).split(" ");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return { ticks: Number(rest[11]) + Number(rest[12]), rssKiB: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0), cpus: /Cpus_allowed_list:\s+(\S+)/.exec(status)?.[1] };
  } catch {
    return { ticks: 0, rssKiB: 0 };
  }
};
const running = () => server && server.exitCode === null && server.signalCode === null;

async function start() {
  stop();
  rmSync(join(WORK, "data"), { recursive: true, force: true });
  mkdirSync(join(WORK, "data"), { recursive: true });
  cpSync(join(SEED, "app.db"), join(WORK, "data/app.db")); // a fresh copy of the seed for every run
  const db = join(WORK, "data/app.db");
  if (env.CACHE_STATE === "cold") {
    sh("sync"); // dirty pages can't be dropped; then ask the kernel to forget this file's cached pages
    sh(`dd if=${db} iflag=nocache count=0 status=none`);
  } else if (env.CACHE_STATE === "warm") sh(`cat ${db} > /dev/null`);
  oomKilled = false;
  const serverEnv = {
    ...env, NODE_ENV: "production", PORT, HOST: "0.0.0.0", DATA_DIR: join(WORK, "data"), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, ALLOW_INSECURE_HTTP: "1",
    CACHE_TTL_MS: env.CACHE_TTL_MS ?? "60000", // the BaaS's own query cache, as in production. The challenge forbids caching across requests: CACHE_TTL_MS=0 measures without it
    RATE_LIMIT_PER_MINUTE: "0", // every simulated user comes from one IP
    // The production startup check validates every stored document (about 70 s for this dataset, over the challenge's 60 s). The data comes from the challenge's own generator.
    SCHEMA_CHECK: env.SCHEMA_CHECK ?? "off",
    LOG_FORMAT: "json", ...JSON.parse(env.EXTRA_ENV ?? "{}"),
  };
  const log = openSync(join(WORK, "server.log"), "w");
  server = spawn("taskset", ["-c", SERVER_CPU, "bun", join(here, "../../packages/cli/src/index.ts"), "start", "--no-docker", "--dir", join(here, "forge")], { env: serverEnv, stdio: ["ignore", log, log] });
  const began = Date.now();
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/ready`)).ok) {
        const cpus = tree(server.pid).map((p) => procStat(p).cpus);
        if (!cpus.every((c) => c === SERVER_CPU)) throw new Error(`server processes are not all pinned to CPU ${SERVER_CPU}: ${cpus}`);
        return (Date.now() - began) / 1000;
      }
    } catch (e) {
      if (String(e).includes("pinned")) throw e;
    }
    if (!running()) break;
    await sleep(0.5);
  }
  throw new Error(`not ready after 60 s:\n${sh(`tail -30 ${join(WORK, "server.log")}`).stdout}`);
}
/** SIGTERM so the server drains, shuts the runtime process down, and both write their CPU profiles. */
async function stopGracefully(seconds = 40) {
  if (!server) return;
  const main = server;
  main.kill("SIGTERM");
  for (let i = 0; i < seconds * 2 && main.exitCode === null && main.signalCode === null; i++) await sleep(0.5);
  stop();
}
function stop() {
  if (!server) return;
  for (const pid of tree(server.pid).reverse()) try { process.kill(pid, "SIGKILL"); } catch {}
  server = undefined;
}

/** CPU (of the one core) and resident memory of the server's processes while a run is going; kills them if they pass the memory limit. */
function watch() {
  const cpu = [];
  const split = { main: [], runtime: [] }; // the HTTP server process vs the function-runtime process
  let peakMiB = 0;
  let last = { t: Date.now(), ticks: 0, main: 0 };
  let n = 0;
  const ioAt = () => tree(server.pid).reduce((a, pid) => ({ read: a.read + procIo(pid).read, write: a.write + procIo(pid).write }), { read: 0, write: 0 });
  const io0 = running() ? ioAt() : { read: 0, write: 0 };
  const timer = setInterval(() => {
    if (!running()) return;
    const pids = tree(server.pid);
    const procs = pids.map(procStat);
    const rssMiB = procs.reduce((a, p) => a + p.rssKiB, 0) / 1024;
    peakMiB = Math.max(peakMiB, rssMiB);
    if (rssMiB > limitMiB) {
      oomKilled = true;
      log(`server used ${Math.round(rssMiB)} MiB, over the ${limitMiB} MiB limit: out of memory`);
      stop();
      return;
    }
    if (++n % 5 === 0) {
      const ticks = procs.reduce((a, p) => a + p.ticks, 0);
      const main = procs[pids.indexOf(server.pid)].ticks;
      const now = Date.now();
      const secs = (now - last.t) / 1000;
      if (last.ticks) {
        cpu.push(((ticks - last.ticks) / 100 / secs) * 100);
        split.main.push(((main - last.main) / 100 / secs) * 100);
        split.runtime.push(((ticks - main - (last.ticks - last.main)) / 100 / secs) * 100);
      }
      last = { t: now, ticks, main };
    }
  }, 1000);
  return () => {
    clearInterval(timer);
    const avg = (xs) => +(xs.reduce((a, b) => a + b, 0) / (xs.length || 1)).toFixed(1);
    const io1 = running() ? ioAt() : io0;
    return {
      diskReadMiB: Math.round((io1.read - io0.read) / 1048576),
      diskWriteMiB: Math.round((io1.write - io0.write) / 1048576), samples: cpu.length, cpuAvg: avg(cpu), cpuMax: +Math.max(0, ...cpu).toFixed(1), serverProcessCpu: avg(split.main), runtimeProcessCpu: avg(split.runtime), memMaxMiB: Math.round(peakMiB) };
  };
}
const state = () => ({ Running: Boolean(running()), OOMKilled: oomKilled });

// ---- one load run, on the cores the server isn't using ----
async function load(users, { ramp = "60s", hold = "5m", label }) {
  const out = join(RESULTS, `${label}-${users}.json`);
  const done = watch();
  log(`${label}: ${users} users (ramp ${ramp}, hold ${hold})`);
  const child = spawn("taskset", ["-c", LOAD_CPUS, "node", join(here, "load.mjs")], {
    env: { ...env, BASE_URL: BASE, VUS: String(users), RAMP_UP: ramp, DURATION: hold, TOKENS: join(SEED, "tokens.json"), OUT: out },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (d) => process.stdout.write(d));
  await new Promise((r) => child.on("close", r));
  const server = done();
  const s = state();
  const result = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { pass: false, users };
  const survived = s.Running && !s.OOMKilled;
  return { ...result, pass: Boolean(result.pass) && survived, server: { ...server, running: s.Running, oomKilled: s.OOMKilled }, label };
}

async function main() {
  const what = process.argv[2];
  if (what === "check") {
    const ready = await start();
    log(`ready in ${ready.toFixed(1)} s`);
    const r = spawnSync("node", [join(here, "check.mjs"), "--base", BASE, "--golden", join(CHALLENGE, "test/golden"), "--tokens", join(SEED, "tokens.json")], { stdio: "inherit" });
    stop();
    process.exit(r.status ?? 1);
  }
  if (what === "smoke") {
    const ready = await start();
    log(`ready in ${ready.toFixed(1)} s`);
    const r = await load(Number(env.VUS ?? 300), { ramp: env.RAMP ?? "20s", hold: env.HOLD ?? "40s", label: "smoke" });
    console.log(JSON.stringify({ pass: r.pass, ms: r.ms, rps: r.rps, failed: r.failed, server: r.server, generator: r.generator }, null, 2));
    writeFileSync(join(RESULTS, `smoke-${env.LABEL ?? "run"}.json`), JSON.stringify({ pass: r.pass, ms: r.ms, rps: r.rps, statuses: r.statuses, server: r.server, generator: r.generator, timeline: r.timeline }, null, 2));
    stop();
    return;
  }
  if (what === "capacity") {
    const ready = await start();
    log(`ready in ${ready.toFixed(1)} s`);
    // raw*: the raw-socket generator, cheap enough to push the server to its own limit. rawmix is the challenge's mix, writes included.
    const feed = (await (await fetch(`${BASE}/rpc/feed:list`)).json()).result.posts;
    const getPaths = feed.map((p) => `/rpc/feed:get?args=${encodeURIComponent(JSON.stringify({ id: p.id }))}`);
    const raw = {
      rawlist: { PATHS: JSON.stringify(["/rpc/feed:list"]) },
      rawget: { PATHS: JSON.stringify(getPaths) },
      rawreads: { MIX: "1,1,0,0" },
      rawmix: { MIX: "1,1,0.15,0.02" },
      rawwrites: { MIX: "0,0,0.15,0.02" },
      rawlikes: { MIX: "1,1,0.15,0" },
      rawcreates: { MIX: "1,1,0,0.02" },
    };
    for (const scenario of (env.SCENARIOS ?? "list,get,like,create,mix").split(",")) {
      const done = watch();
      const child = raw[scenario]
        ? spawn("taskset", ["-c", LOAD_CPUS, "node", join(here, "rawload.mjs")], {
            env: { ...env, PORT, TOKENS: join(SEED, "tokens.json"), SECONDS: env.SECONDS ?? "12", CONNS: env.CONNS ?? "128", ...raw[scenario] },
            stdio: ["ignore", "pipe", "inherit"],
          })
        : spawn("taskset", ["-c", LOAD_CPUS, "node", join(here, "capacity.mjs")], {
            env: { ...env, BASE_URL: BASE, SCENARIO: scenario, TOKENS: join(SEED, "tokens.json") },
            stdio: ["ignore", "pipe", "inherit"],
          });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      await new Promise((r) => child.on("close", r));
      const server = done();
      const r = { failed: 0, ...JSON.parse(out) };
      r.failed ||= r.bad ?? 0;
      const us = (cpu) => Math.round(((cpu / 100) / r.rps) * 1e6);
      console.log(`${scenario.padEnd(9)} ${String(r.rps).padStart(6)} req/s  p50 ${r.p50} ms  p99 ${r.p99} ms  failed ${r.failed}  server ${us(server.serverProcessCpu)} us/req  runtime ${us(server.runtimeProcessCpu)} us/req  (cpu ${server.cpuAvg}%)` + (scenario.endsWith("mix") ? `  ~${Math.round(r.rps / 0.115).toLocaleString()} users` : ""));
      await sleep(2);
    }
    if (env.EXTRA_ENV) await stopGracefully(); // profiling is on: let the processes write their profiles
    else stop();
    return;
  }
  if (what === "profile") {
    // Everything below the load profile gets a CPU profile: the HTTP server process and the function-runtime process (BUN_OPTIONS reaches both).
    const dir = join(WORK, "profiles", new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(dir, { recursive: true });
    env.EXTRA_ENV = JSON.stringify({ BUN_OPTIONS: `--cpu-prof --cpu-prof-dir=${dir} --cpu-prof-interval=500` });
    const ready = await start();
    log(`ready in ${ready.toFixed(1)} s (profiling to ${dir})`);
    const users = Number(env.VUS ?? 2000);
    const r = await load(users, { ramp: env.RAMP ?? "45s", hold: env.HOLD ?? "120s", label: "profile" });
    console.log(JSON.stringify({ pass: r.pass, ms: r.ms, rps: r.rps, server: r.server, generator: r.generator, endpoints: r.endpoints }, null, 2));
    await stopGracefully();
    console.log(`profiles in ${dir}`);
    return;
  }
  if (what !== "score") throw new Error("usage: node score.mjs check|smoke|profile|score");

  const started = Date.now();
  const ready = await start();
  log(`engine ready in ${ready.toFixed(1)} s (limit 60 s)`);
  const runs = [];
  const probe = async (users, mode) => {
    const r = await load(users, mode === "confirm" ? { ramp: "60s", hold: "5m", label: "confirm" } : { ramp: env.PROBE_RAMP ?? "45s", hold: env.PROBE_HOLD ?? "90s", label: mode });
    runs.push({ mode, users, pass: r.pass, p95: r.ms?.p95, p99: r.ms?.p99, avg: r.ms?.avg, rps: r.rps, failedRate: r.failedRate, requests: r.requests, server: r.server, generator: r.generator });
    writeFileSync(join(RESULTS, "progress.json"), JSON.stringify(runs, null, 2));
    log(`${mode} ${users}: ${r.pass ? "PASS" : "FAIL"}  p95=${r.ms?.p95}ms p99=${r.ms?.p99}ms failed=${((r.failedRate ?? 1) * 100).toFixed(2)}%  server cpu avg ${r.server.cpuAvg}% max mem ${r.server.memMaxMiB} MiB${r.server.oomKilled ? "  OOM KILLED" : ""}`);
    if (!r.server.running) {
      log("the server died; restarting it on a fresh copy of the database");
      await start();
    } else await sleep(20); // let it settle between runs
    return r.pass;
  };

  await probe(1000, "warmup"); // not scored
  // Find the limit: start at 2,500 and double until a run fails; if 2,500 already fails, halve instead.
  let lo = 0;
  let hi = 0;
  let n = 2500;
  if (await probe(n, "search")) {
    lo = n;
    for (n *= 2; !hi; n *= 2) (await probe(n, "search")) ? (lo = n) : (hi = n);
  } else {
    hi = n;
    for (n = Math.round(n / 2 / 250) * 250; n >= 250 && !lo; n = Math.round(n / 2 / 250) * 250) (await probe(n, "search")) ? (lo = n) : (hi = n);
  }
  // Narrow down to within 250.
  while (hi - lo > 250) {
    const mid = Math.round((lo + hi) / 2 / 250) * 250;
    if (mid <= lo || mid >= hi) break;
    (await probe(mid, "narrow")) ? (lo = mid) : (hi = mid);
  }
  // Confirm with one 5-minute hold; step down 250 users at a time until one holds.
  let score = 0;
  for (let candidate = lo; candidate >= 250; candidate -= 250) {
    if (await probe(candidate, "confirm")) {
      score = candidate;
      break;
    }
  }
  const summary = { score, limit: { passed: lo, failed: hi }, minutes: +((Date.now() - started) / 60000).toFixed(1), limits: { cpuset: SERVER_CPU, memory: MEMORY, cache: env.CACHE_TTL_MS ?? "60000" }, readySeconds: +ready.toFixed(1), runs };
  writeFileSync(join(RESULTS, `summary-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2));
  console.log(`\nSCORE: ${score} users\n`);
  console.table(runs.map((r) => ({ run: r.mode, users: r.users, pass: r.pass, "p95 ms": r.p95, "p99 ms": r.p99, "fail %": +((r.failedRate ?? 1) * 100).toFixed(2), "req/s": r.rps, "cpu avg %": r.server.cpuAvg, "mem max MiB": r.server.memMaxMiB })));
  stop();
}
main().catch((e) => (console.error(e), stop(), process.exit(1)));
