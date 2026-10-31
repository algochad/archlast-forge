// Control: Bun.serve answering a fixed 20-document JSON body, nothing else; the same loop-delay report as serve.ts.
import { monitorEventLoopDelay } from "node:perf_hooks";
const body = JSON.stringify({ result: Array.from({ length: 20 }, (_, i) => ({ _id: `todos:${i}`, _creationTime: Date.now(), listId: "lists:1", title: `todo ${i}`, done: false })) });
Bun.serve({ port: Number(process.env.PORT ?? 3100), fetch: () => new Response(body, { headers: { "content-type": "application/json" } }) });
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
console.log("READY");
process.on("SIGUSR2", () => loop.reset());
process.on("SIGTERM", () => {
  const ms = (n: number) => +(n / 1e6).toFixed(2);
  console.log(`LOOP ${JSON.stringify({ p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) })}`);
  process.exit(0);
});
