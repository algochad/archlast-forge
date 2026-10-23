#!/usr/bin/env node
// Closed-loop capacity probe: CONNS keep-alive connections each send the next request as soon as the last one is answered, for SECONDS.
// The server is the bottleneck, so the request rate is the most it can do for this scenario; score.mjs reads its CPU cost per request.
//   SCENARIO=list|get|like|create|mix  BASE_URL  CONNS (64)  SECONDS (8)  TOKENS
import http from "node:http";
import { readFileSync } from "node:fs";

const env = process.env;
const BASE = new URL(env.BASE_URL ?? "http://127.0.0.1:3100");
const CONNS = Number(env.CONNS ?? 64);
const SECONDS = Number(env.SECONDS ?? 12);
const SCENARIO = env.SCENARIO ?? "mix";
const tokens = JSON.parse(readFileSync(env.TOKENS, "utf8"));
const agent = new http.Agent({ keepAlive: true, maxSockets: CONNS });

const request = (method, path, body, cookie) =>
  new Promise((resolve) => {
    const headers = body === undefined ? {} : { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ agent, hostname: BASE.hostname, port: BASE.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end(body);
  });

const feed = JSON.parse((await request("GET", "/rpc/feed:list")).body).result.posts;
const pick = () => feed[Math.floor(Math.random() * feed.length)].id;
const user = () => tokens[Math.floor(Math.random() * tokens.length)];
const ops = {
  list: () => request("GET", "/rpc/feed:list"),
  get: () => request("GET", `/rpc/feed:get?args=${encodeURIComponent(JSON.stringify({ id: pick() }))}`),
  like: () => request("POST", "/rpc/feed:like", JSON.stringify({ postId: pick() }), user().cookie),
  create: () => request("POST", "/rpc/feed:create", JSON.stringify({ body: `capacity ${Math.random()}` }), user().cookie),
};
// The challenge's request mix: a feed and a post per user visit, 15% of visits like, 2% write.
const mix = () => {
  const r = Math.random() * 2.17;
  return r < 1 ? ops.list() : r < 2 ? ops.get() : r < 2.15 ? ops.like() : ops.create();
};
const op = SCENARIO === "mix" ? mix : ops[SCENARIO];

const end = performance.now() + SECONDS * 1000;
const ms = [];
let failed = 0;
await Promise.all(
  Array.from({ length: CONNS }, async () => {
    while (performance.now() < end) {
      const t = performance.now();
      const r = await op();
      ms.push(performance.now() - t);
      if (r.status >= 400 || r.status === 0) failed++;
    }
  }),
);
ms.sort((a, b) => a - b);
const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
console.log(JSON.stringify({ scenario: SCENARIO, requests: ms.length, rps: Math.round(ms.length / SECONDS), failed, p50: +pct(0.5).toFixed(2), p99: +pct(0.99).toFixed(2) }));
agent.destroy();
