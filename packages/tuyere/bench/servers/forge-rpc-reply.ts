// Forge's real createRpc handler with every `new Response(` replaced by the engine's `new Reply(` (patched copy in a temp
// directory; the Forge checkout is not modified). Shows what the engine's native response type is worth on Forge's hot path.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reply } from "../../src/index.ts";
import { serveCompat } from "../../src/compat.ts";

const FORGE =
  process.env.FORGE ??
  "/home/algochad/Projects/archlast-forge-engine/packages/runtime/src";
const dir = mkdtempSync(join(tmpdir(), "forge-rpc-reply-"));
cpSync(join(FORGE, "forge-rpc"), join(dir, "forge-rpc"), { recursive: true });
const file = join(dir, "forge-rpc", "server.ts");
let src = readFileSync(file, "utf8").replaceAll(
  "new Response(",
  "new (globalThis as any).__Reply(",
);
writeFileSync(file, src);
(globalThis as any).__Reply = Reply;
const { createRpc } = await import(file);
const { z } = await import(join(FORGE, "..", "node_modules", "zod"));

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
  ]),
  authorized: (h: string | null) => h === "Bearer bench-token",
});
serveCompat({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  backend: (process.env.ARCHLAST_BACKEND as never) ?? "napi",
  threads: Number(process.env.THREADS ?? 2),
  fetch: (req, server) => rpc.fetch(req, server),
  websocket: rpc.websocket,
});
if (process.env.AUTOEXIT)
  setTimeout(() => process.exit(0), Number(process.env.AUTOEXIT));
