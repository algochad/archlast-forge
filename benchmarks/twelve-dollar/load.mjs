#!/usr/bin/env node
// A port of the challenge's bench/load.js (k6) for the RPC version of the API, for machines where k6 can't hold
// thousands of virtual users (k6 keeps a JavaScript runtime per user; this keeps a few KB).
//
//   VUS=2500 node load.mjs                      env: BASE_URL, VUS, RAMP_UP (60s), DURATION (5m), TOKENS, OUT
//
// Same scenario as load.js: users ramp up over RAMP_UP, hold for DURATION, ramp down over 30 s. Each user, on its own
// keep-alive connection, loops: GET feed -> think 3-7 s -> GET post -> think 3-8 s -> like it (15%) -> write a post (2%)
// -> idle 5-15 s. The first iteration waits 0-5 s to spread users out. Pass: p95 < 500 ms, p99 < 1 s, under 1% failed
// requests (a request fails on a connection error or a status of 400 or more), over every request in the run.
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const env = process.env;
const seconds = (s, fallback) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(s ?? fallback);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60 }[m[2]];
};
const BASE = new URL(env.BASE_URL ?? "http://127.0.0.1:3000");
const VUS = Number(env.VUS ?? 100);
const RAMP_UP = seconds(env.RAMP_UP, "60s");
const HOLD = seconds(env.DURATION, "5m");
const RAMP_DOWN = 30;
const END = RAMP_UP + HOLD + RAMP_DOWN;
const tokens = JSON.parse(readFileSync(env.TOKENS ?? new URL("./tokens.json", import.meta.url), "utf8"));
const LIKE_PROB = 0.15;
const POST_PROB = 0.02;

const t0 = performance.now();
const clock = () => (performance.now() - t0) / 1000;
const between = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000));

// ---- metrics ----
const all = [];
const byName = {};
let failed = 0;
let active = 0;
const window = []; // [clock, ms, failed] for the rolling view
const statuses = {};
function record(name, r) {
  const bad = r.status < 200 || r.status >= 400;
  all.push(r.ms);
  (byName[name] ??= { ms: [], failed: 0 }).ms.push(r.ms);
  if (bad) (failed++, byName[name].failed++);
  statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  window.push([clock(), r.ms, bad]);
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0);
const stats = (ms) => {
  const s = [...ms].sort((a, b) => a - b);
  return { count: s.length, avg: s.reduce((a, b) => a + b, 0) / (s.length || 1), med: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: s.at(-1) ?? 0 };
};

// ---- one request on a user's own connection ----
function request(agent, method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const done = (status, buf) => resolve({ status, ms: performance.now() - start, body: buf });
    const req = http.request({ agent, hostname: BASE.hostname, port: BASE.port, method, path, headers, timeout: 60_000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => done(res.statusCode ?? 0, Buffer.concat(chunks)));
      res.on("error", () => done(0));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => done(0));
    req.end(body);
  });
}

async function user(i, startAt, stopAt) {
  await sleep(startAt - clock());
  const me = tokens[(i - 1) % tokens.length];
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const auth = { Cookie: me.cookie, "Content-Type": "application/json" };
  active++;
  const wait = (s) => sleep(Math.min(s, stopAt - clock()));
  try {
    for (let iter = 0; clock() < stopAt; iter++) {
      if (iter === 0) await wait(between(0, 5));
      if (clock() >= stopAt) break;
      const feed = await request(agent, "GET", "/rpc/feed:list");
      record("feed.list", feed);
      if (feed.status !== 200) {
        await wait(between(3, 7));
        continue;
      }
      const posts = JSON.parse(feed.body).result.posts;
      const post = posts[Math.floor(Math.random() * posts.length)];
      await wait(between(3, 7));
      if (clock() >= stopAt) break;

      record("feed.get", await request(agent, "GET", `/rpc/feed:get?args=${encodeURIComponent(JSON.stringify({ id: post.id }))}`));
      await wait(between(3, 8));
      if (clock() >= stopAt) break;

      if (Math.random() < LIKE_PROB) record("feed.like", await request(agent, "POST", "/rpc/feed:like", JSON.stringify({ postId: post.id }), auth));
      if (Math.random() < POST_PROB) {
        const body = JSON.stringify({ body: `${me.username} says hi at ${new Date().toISOString()} (VU ${i}, iter ${iter})` });
        record("feed.create", await request(agent, "POST", "/rpc/feed:create", body, auth));
      }
      await wait(between(5, 15));
    }
  } finally {
    active--;
    agent.destroy();
  }
}

// ---- progress and the generator's own health (a saturated generator would flatter or smear the numbers) ----
let maxLag = 0;
let tick = performance.now();
setInterval(() => {
  const now = performance.now();
  maxLag = Math.max(maxLag, now - tick - 100);
  tick = now;
}, 100).unref();
const timeline = [];
const progress = setInterval(() => {
  const from = clock() - 10;
  const recent = window.filter((w) => w[0] >= from);
  const ms = recent.map((w) => w[1]).sort((a, b) => a - b);
  const row = { t: Math.round(clock()), vus: active, rps: +(recent.length / 10).toFixed(1), p95: +pct(ms, 0.95).toFixed(1), p99: +pct(ms, 0.99).toFixed(1), errors: recent.filter((w) => w[2]).length };
  timeline.push(row);
  console.log(`  t=${String(row.t).padStart(4)}s vus=${String(row.vus).padStart(5)} rps=${String(row.rps).padStart(7)} p95=${String(row.p95).padStart(7)}ms p99=${String(row.p99).padStart(7)}ms errors=${row.errors}`);
  window.splice(0, window.length - 60_000);
}, 10_000);

console.log(`users=${VUS} ramp=${RAMP_UP}s hold=${HOLD}s base=${BASE.origin}`);
const cpu0 = process.cpuUsage();
await Promise.all(
  Array.from({ length: VUS }, (_, k) => {
    const i = k + 1;
    return user(i, ((i - 1) / VUS) * RAMP_UP, RAMP_UP + HOLD + ((VUS - i) / VUS) * RAMP_DOWN);
  }),
);
clearInterval(progress);
const cpu = process.cpuUsage(cpu0);

const total = stats(all);
const failedRate = failed / (all.length || 1);
const pass = total.p95 < 500 && total.p99 < 1000 && failedRate < 0.01;
const summary = {
  users: VUS,
  pass,
  requests: all.length,
  rps: +(all.length / END).toFixed(1),
  ms: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, +v.toFixed(2)])),
  failed,
  failedRate: +failedRate.toFixed(5),
  statuses,
  endpoints: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, { ...Object.fromEntries(Object.entries(stats(v.ms)).map(([a, b]) => [a, +b.toFixed(2)])), failed: v.failed }])),
  generator: { cpuSeconds: +((cpu.user + cpu.system) / 1e6).toFixed(1), maxEventLoopLagMs: +maxLag.toFixed(1) },
  timeline,
};
if (env.OUT) writeFileSync(env.OUT, JSON.stringify(summary, null, 2));
console.log(
  `${pass ? "PASS" : "FAIL"} users=${VUS} requests=${all.length} p95=${summary.ms.p95}ms p99=${summary.ms.p99}ms avg=${summary.ms.avg}ms max=${summary.ms.max}ms failed=${(failedRate * 100).toFixed(3)}% (generator: ${summary.generator.cpuSeconds}s cpu, max loop lag ${summary.generator.maxEventLoopLagMs}ms)`,
);
process.exit(pass ? 0 : 1);
