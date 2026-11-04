#!/usr/bin/env node
// The same measurement as ../fanout.ts, for Convex (SYSTEM=convex, the default): CLIENTS ConvexClient instances (one WebSocket each) watch
// todos:listByList on one list with client.onUpdate while a writer adds RATE todos a second for SECONDS over HTTP. Each title carries its send time.
//   SYSTEM=forge runs the same code against archlast-forge's /rpc WebSocket, so the two can also be compared with identical client-side code.
// Two latencies, both from the write's send time:
//   p50..max          fanout.ts's: when a client first sees the newest row it has seen so far (updates a client never sees are not counted)
//   perWrite*         every write for every client: when the client first saw that write's row, in the update that showed it or a later one
// settleMs is how long after the last write the slowest client took to see it (capped at 60 s).
// "updates" counts update messages after the first; if a server merges two writes into one update (Convex may), updates < writes * CLIENTS and the
// merged writes show their wait in perWrite*. missing = writes a client never saw by the end.
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

const env = process.env;
const SYSTEM = env.SYSTEM ?? "convex";
const url = env.CONVEX_URL ?? (SYSTEM === "convex" ? "http://127.0.0.1:3210" : "http://127.0.0.1:3100");
const CLIENTS = Number(env.CLIENTS ?? 500);
const RATE = Number(env.RATE ?? 10);
const SECONDS = Number(env.SECONDS ?? 15);
const call = async (path, args) => {
  if (SYSTEM === "forge") {
    const r = await (await fetch(`${url}/rpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) })).json();
    if (!("result" in r)) throw new Error(JSON.stringify(r));
    return r.result;
  }
  const r = await (await fetch(`${url}/api/mutation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args, format: "json" }) })).json();
  if (r.status !== "success") throw new Error(JSON.stringify(r));
  return r.value;
};

const listId = await call("todos:createList", { name: "fanout" });
const lat = []; // fanout.ts's metric
const perWrite = []; // every write, every client
let received = 0;
const handles = [];
const state = []; // per client: [updates, writes seen]
await Promise.all(
  Array.from({ length: CLIENTS }, (_, i) =>
    new Promise((resolve) => {
      const st = [0, 0];
      state.push(st);
      let seen = 0;
      let first = true;
      const onRows = (rows) => {
        const now = Date.now();
        if (first) return ((first = false), resolve());
        received++;
        st[0]++;
        let newest = 0;
        for (let k = st[1]; k < rows.length; k++) {
          const t = Number(rows[k].title.split(" ")[1]) || 0;
          perWrite.push(now - t);
          if (t > newest) newest = t;
        }
        st[1] = rows.length;
        if (newest > seen) ((seen = newest), lat.push(now - newest));
      };
      if (SYSTEM === "forge") {
        const ws = new WebSocket(url.replace(/^http/, "ws") + "/rpc");
        handles.push(ws);
        ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", id: "1", name: "todos:listByList", args: { listId } }));
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.type === "data") onRows(m.data.value);
        };
      } else {
        const client = new ConvexClient(url, { unsavedChangesWarning: false });
        handles.push(client);
        client.onUpdate(anyApi.todos.listByList, { listId }, onRows);
      }
    }),
  ),
);
let writes = 0;
const end = Date.now() + SECONDS * 1000;
while (Date.now() < end) {
  const t = Date.now();
  await call("todos:add", { listId, title: `w ${t}` });
  writes++;
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 / RATE - (Date.now() - t))));
}
// let a backlog drain: wait until every client has seen every write (at most 60 s) and say how long that took
const drainStart = Date.now();
while (Date.now() - drainStart < 60000 && state.some((st) => st[1] < writes)) await new Promise((r) => setTimeout(r, 100));
const settleMs = Date.now() - drainStart;
const missing = state.reduce((n, st) => n + (writes - st[1]), 0);
const clientsSeeingEveryWrite = state.filter((st) => st[1] === writes).length;
const updatesPerClient = state.map((st) => st[0]).sort((a, b) => a - b);
for (const h of handles) SYSTEM === "forge" ? h.close() : await h.close();
lat.sort((a, b) => a - b);
perWrite.sort((a, b) => a - b);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] ?? null;
console.log(
  JSON.stringify({
    system: SYSTEM,
    clients: CLIENTS,
    writes,
    updates: received,
    expected: writes * CLIENTS,
    clientsSeeingEveryWrite,
    missing,
    settleMs,
    updatesPerClientMedian: updatesPerClient[updatesPerClient.length >> 1],
    p50: q(lat, 0.5),
    p90: q(lat, 0.9),
    p99: q(lat, 0.99),
    max: lat.at(-1) ?? null,
    perWriteP50: q(perWrite, 0.5),
    perWriteP90: q(perWrite, 0.9),
    perWriteP99: q(perWrite, 0.99),
    perWriteMax: perWrite.at(-1) ?? null,
    runsPerWrite: null,
  }),
);
process.exit(0);
