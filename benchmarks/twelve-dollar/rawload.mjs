#!/usr/bin/env node
// A cheap closed-loop HTTP/1.1 load generator on raw sockets: CONNS keep-alive connections, each sends its next request as soon as the last
// response is complete. It spends little CPU per request, so one core of it can push a single-core server to its own limit.
//   node rawload.mjs   env: HOST (127.0.0.1) PORT (3100) CONNS (128) SECONDS (10) TOKENS (tokens.json, for writes)
//     MIX    weights of list,get,like,create, e.g. "1,1,0.15,0.02" (the challenge's visit: a feed, a post, 15% like, 2% write); default reads only
//     PATHS  instead of MIX: a JSON array of GET paths, sent round-robin
import net from "node:net";
import { readFileSync } from "node:fs";

const env = process.env;
const HOST = env.HOST ?? "127.0.0.1";
const PORT = Number(env.PORT ?? 3100);
const CONNS = Number(env.CONNS ?? 128);
const SECONDS = Number(env.SECONDS ?? 10);
const base = `http://${HOST}:${PORT}`;

const get = (path) => Buffer.from(`GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
const post = (path, body, cookie) =>
  Buffer.from(`POST ${path} HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCookie: ${cookie}\r\n\r\n${body}`);

let next;
const kinds = { list: 0, get: 0, like: 0, create: 0 };
if (env.PATHS) {
  const paths = JSON.parse(env.PATHS).map(get);
  let i = 0;
  next = () => paths[i++ % paths.length];
} else {
  const ids = (await (await fetch(`${base}/rpc/feed:list`)).json()).result.posts.map((p) => p.id);
  const tokens = env.TOKENS ? JSON.parse(readFileSync(env.TOKENS, "utf8")) : [];
  const [wList, wGet, wLike, wCreate] = (env.MIX ?? "1,1,0,0").split(",").map(Number);
  if ((wLike || wCreate) && !tokens.length) throw new Error("writes need TOKENS");
  const total = wList + wGet + wLike + wCreate;
  const listReq = get("/rpc/feed:list");
  const getReqs = ids.map((id) => get(`/rpc/feed:get?args=${encodeURIComponent(JSON.stringify({ id }))}`));
  // Each like is a new (user, post) pair, so it inserts rather than finding an existing like.
  let likes = Math.floor(Math.random() * tokens.length * ids.length);
  let created = 0;
  next = () => {
    const r = Math.random() * total;
    if (r < wList) return kinds.list++, listReq;
    if (r < wList + wGet) return kinds.get++, getReqs[Math.floor(Math.random() * getReqs.length)];
    if (r < wList + wGet + wLike) {
      const n = likes++;
      kinds.like++;
      return post("/rpc/feed:like", JSON.stringify({ postId: ids[n % ids.length] }), tokens[Math.floor(n / ids.length) % tokens.length].cookie);
    }
    kinds.create++;
    return post("/rpc/feed:create", JSON.stringify({ body: `rawload ${created++} ${Date.now()}` }), tokens[created % tokens.length].cookie);
  };
}

let done = 0;
let bad = 0;
const lat = [];
const end = performance.now() + SECONDS * 1000;

function connection() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, HOST);
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let sentAt = 0;
    const send = () => {
      sentAt = performance.now();
      socket.write(next());
    };
    socket.on("connect", send);
    socket.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const head = buf.indexOf("\r\n\r\n");
        if (head < 0) return;
        const text = buf.toString("latin1", 0, head);
        const len = Number(/content-length: (\d+)/i.exec(text)?.[1] ?? 0);
        if (buf.length < head + 4 + len) return;
        if (!/^HTTP\/1\.1 2/.test(text)) bad++;
        buf = buf.subarray(head + 4 + len);
        done++;
        lat.push(performance.now() - sentAt);
        if (performance.now() < end) send();
        else return socket.destroy();
      }
    });
    socket.on("close", resolve);
    socket.on("error", () => {});
  });
}

const t0 = performance.now();
await Promise.all(Array.from({ length: CONNS }, connection));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0;
console.log(JSON.stringify({ requests: done, rps: Math.round(done / secs), bad, p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2), kinds }));
