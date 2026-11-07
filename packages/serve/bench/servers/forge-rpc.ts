// Forge's real RPC handler (createRpc from the archlast-forge checkout) served by Bun.serve or by archlast-serve's
// Bun.serve-shaped facade. ENGINE=bun|archlast, PORT, FORGE=<path to the archlast-forge packages/runtime/src dir>.
const FORGE_ROOT =
  process.env.FORGE ??
  "/home/algochad/Projects/archlast-forge-engine/packages/runtime/src";
const { z } = await import(`${FORGE_ROOT}/../node_modules/zod`);
import { serveCompat } from "../../src/compat.ts";

const FORGE =
  process.env.FORGE ??
  "/home/algochad/Projects/archlast-forge-engine/packages/runtime/src";
const { createRpc } = await import(`${FORGE}/forge-rpc/server.ts`);

const TOKEN = "bench-token";
const EXPECTED = `Bearer ${TOKEN}`;
const rpc = createRpc({
  procedures: new Map([
    [
      "echo.back",
      {
        kind: "query",
        input: z.object({ blob: z.string() }),
        output: z.object({ n: z.number() }),
        run: async (i: { blob: string }) => ({ n: i.blob.length }),
      },
    ],
    ["echo.raw", { kind: "query", run: async () => ({ ok: true }) }],
  ]),
  authorized: (h: string | null) => h === EXPECTED,
});
const port = Number(process.env.PORT ?? 4001);
if (process.env.ENGINE === "archlast") {
  serveCompat({
    port,
    hostname: "127.0.0.1",
    backend: (process.env.ARCHLAST_BACKEND as never) ?? "napi",
    threads: Number(process.env.THREADS ?? 2),
    fetch: (req, server) => rpc.fetch(req, server),
    websocket: rpc.websocket,
  });
} else {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req, server) => rpc.fetch(req, server),
    websocket: rpc.websocket,
  });
}
if (process.env.AUTOEXIT)
  setTimeout(() => process.exit(0), Number(process.env.AUTOEXIT));
