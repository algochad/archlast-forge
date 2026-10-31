#!/usr/bin/env node
// Closed-loop HTTP/1.1 load on raw keep-alive sockets (after benchmarks/twelve-dollar/rawload.mjs), for one request shape.
//   env: PORTS (comma list, round-robin over connections) CONNS SECONDS, and either REQ_PATH (GET) or POST_PATH + BODY (a template; {n} -> a counter)
// Prints JSON: requests, rps, p50/p90/p99/max (ms), non-2xx count.
import net from "node:net";

const env = process.env;
const PORTS = (env.PORTS ?? "3100").split(",").map(Number);
const CONNS = Number(env.CONNS ?? 64);
const SECONDS = Number(env.SECONDS ?? 20);
let n = 0;
const next = env.POST_PATH
  ? () => {
      const body = env.BODY.replaceAll("{n}", String(n++));
      return Buffer.from(`POST ${env.POST_PATH} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  : env.REQ_PATHS
    ? (
        (reqs) => () =>
          reqs[n++ % reqs.length]
      )(JSON.parse(env.REQ_PATHS).map((p) => Buffer.from(`GET ${p} HTTP/1.1\r\nHost: x\r\n\r\n`)))
    : (
        (req) => () =>
          req
      )(Buffer.from(`GET ${env.REQ_PATH} HTTP/1.1\r\nHost: x\r\n\r\n`));

let done = 0;
let bad = 0;
const lat = [];
const end = performance.now() + SECONDS * 1000;

function connection(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let sentAt = 0;
    // RATE (requests a second in total) makes it open-loop: each connection has a schedule, and latency counts from the scheduled time,
    // so a server that falls behind shows its queue in the numbers instead of slowing the load down.
    const interval = Number(env.RATE) ? (CONNS * 1000) / Number(env.RATE) : 0;
    let slot = performance.now() + Math.random() * interval;
    const send = () => {
      if (!interval) return ((sentAt = performance.now()), socket.write(next()));
      sentAt = slot;
      slot += interval;
      const wait = sentAt - performance.now();
      wait > 0 ? setTimeout(() => socket.write(next()), wait) : socket.write(next());
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
        else return (socket.end(), resolve());
      }
    });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

const t0 = performance.now();
await Promise.all(Array.from({ length: CONNS }, (_, i) => connection(PORTS[i % PORTS.length])));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const q = (p) => +lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(2);
console.log(JSON.stringify({ requests: done, rps: Math.round(done / secs), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +lat.at(-1).toFixed(1), non2xx: bad }));
