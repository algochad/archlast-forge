// The same JSON-over-HTTP handler returning a Web Response or the engine's Reply, to size what building and reading a
// Response costs. MODE=response|reply   PORT   (archlast-serve through the Bun.serve-shaped facade)
import { serveCompat } from "../../src/compat.ts";
import { Reply } from "../../src/index.ts";

const body = JSON.stringify({ result: { data: { n: 16 } } });
const mode = process.env.MODE ?? "response";
serveCompat({
    port: Number(process.env.PORT),
    hostname: "127.0.0.1",
    backend: (process.env.ARCHLAST_BACKEND as never) ?? "napi",
    threads: Number(process.env.THREADS ?? 2),
    async fetch(req) {
        await req.text();
        const headers = { "content-type": "application/json" };
        return mode === "reply" ? (new Reply(body, { status: 200, headers }) as never) : new Response(body, { status: 200, headers });
    },
});
if (process.env.AUTOEXIT) setTimeout(() => process.exit(0), Number(process.env.AUTOEXIT));
