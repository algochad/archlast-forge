// Subscription fan-out. CLIENTS WebSocket clients watch todos:listByList on one list; a writer adds RATE todos a second for SECONDS.
// Each title carries its send time, so an update's delivery latency is when the client sees the newest title minus when it was written.
// Prints JSON: writes, client updates received, delivery p50/p90/p99/max, and function runs of the query per write (from /metrics).
const env = process.env;
const PORT = env.PORT ?? "3100";
const CLIENTS = Number(env.CLIENTS ?? 500);
const RATE = Number(env.RATE ?? 10);
const SECONDS = Number(env.SECONDS ?? 15);
const base = `http://127.0.0.1:${PORT}`;
const KEY = "bench-admin-key-0123456789abcdef0123";
const call = async (name: string, args: object) =>
  ((await (await fetch(`${base}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) })).json()) as any).result;
const runs = async () => {
  const text = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${KEY}` } })).text();
  return Number(/forge_function_calls_total\{function="todos:listByList"\} (\d+)/.exec(text)?.[1] ?? 0);
};

const listId = await call("todos:createList", { name: "fanout" });
const lat: number[] = [];
let received = 0;
const sockets: WebSocket[] = [];
await Promise.all(
  Array.from(
    { length: CLIENTS },
    (_, i) =>
      new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/rpc`);
        sockets.push(ws);
        let seen = 0;
        let first = true;
        ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", id: "1", name: "todos:listByList", args: { listId } }));
        ws.onmessage = (e) => {
          const now = Date.now();
          const m = JSON.parse(String(e.data));
          if (m.type !== "data") return;
          if (first) return ((first = false), resolve());
          received++;
          const sent = Math.max(...(m.data.value as { title: string }[]).map((t) => Number(t.title.split(" ")[1]) || 0));
          if (sent > seen) ((seen = sent), lat.push(now - sent));
        };
      }),
  ),
);
const before = await runs();
let writes = 0;
const end = Date.now() + SECONDS * 1000;
while (Date.now() < end) {
  const t = Date.now();
  await call("todos:add", { listId, title: `w ${t}` });
  writes++;
  await Bun.sleep(Math.max(0, 1000 / RATE - (Date.now() - t)));
}
await Bun.sleep(1500);
const after = await runs();
for (const ws of sockets) ws.close();
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? null;
console.log(
  JSON.stringify({
    clients: CLIENTS,
    writes,
    updates: received,
    expected: writes * CLIENTS,
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    max: lat.at(-1) ?? null,
    runsPerWrite: +((after - before) / writes).toFixed(2),
  }),
);
process.exit(0);
