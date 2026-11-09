// Serves the fixture site on the engine; argv: "dev" turns the dev server (HMR, console forwarding) on.
import { serveCompat } from "../../src/compat.ts";
import page from "./site/index.html";

const dev = process.argv[2] === "dev";
const s = serveCompat({
  port: 0,
  backend: (process.argv[3] as "napi" | "bun-ffi") ?? "napi",
  development: dev ? { hmr: true, console: true } : false,
  routes: {
    "/": page,
    "/slow.png": async () => {
      await new Promise((r) => setTimeout(r, 1200));
      return new Response(
        Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          ),
          (c) => c.charCodeAt(0),
        ),
        { headers: { "content-type": "image/png" } },
      );
    },
  },
});
process.stdout.write(`PORT ${s.port}\n`);
setInterval(() => {}, 1 << 30);
