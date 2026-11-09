// The same handler on the engine's native App API (a light Context instead of a Web Request, and Reply instead of Response).
import { App, Reply } from "../../src/index.ts";

const body = JSON.stringify({ result: { data: { n: 16 } } });
const headers = { "content-type": "application/json" };
new App()
  .post("/x", async (c) => {
    await c.text();
    return new Reply(body, { status: 200, headers });
  })
  .listen({
    port: Number(process.env.PORT),
    hostname: "127.0.0.1",
    backend: (process.env.ARCHLAST_BACKEND as never) ?? "napi",
    threads: Number(process.env.THREADS ?? 2),
  });
