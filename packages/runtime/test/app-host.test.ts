import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { AppEnv } from "../src/server/server";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
let srv: RunningServer;
let disposed = false;
let seen: AppEnv | undefined;

beforeAll(async () => {
  srv = await startServer({
    forgeDir: fixture,
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json" },
    app: {
      async fetch(req, env) {
        seen = env;
        const path = new URL(req.url).pathname;
        if (path === "/page") {
          const id = await env.call("todos:createList", "mutation", { name: "from app" });
          const counts = (await env.call("todos:listCounts", "query")) as { name: string }[];
          return Response.json({ id, names: counts.map((c) => c.name), user: await env.identity() });
        }
        if (path === "/fails") return Response.json(await env.call("todos:forgeFail", "mutation").catch((e) => ({ data: e.data, name: e.name })));
        if (path === "/internal") return Response.json(await env.call("todos:secretCount", "query").catch((e) => ({ message: e.message })));
        if (path === "/crash") return Response.json(await env.call("todos:crash", "query").catch((e) => ({ message: e.message })));
        if (path === "/rpc/anything") return new Response("the app must not see engine paths");
      },
      dispose: () => void (disposed = true),
    },
  });
});
afterAll(() => srv.stop({ graceful: false }));

test("the host gets unowned paths and can call functions as the caller", async () => {
  const body = (await (await fetch(`${srv.url}/page`)).json()) as any;
  expect(body.id).toMatch(/^lists:/);
  expect(body.names).toContain("from app");
  expect(body.user).toBeNull();
  expect(seen?.requestId).toBeTruthy();
  expect(await seen?.rateLimited()).toBeNull();
});

test("failures reach the host the way clients see them", async () => {
  expect(await (await fetch(`${srv.url}/fails`)).json()).toEqual({ data: { code: "LIMIT", max: 3 }, name: "ForgeError" });
  expect(((await (await fetch(`${srv.url}/internal`)).json()) as any).message).toContain("Unknown function");
  expect(((await (await fetch(`${srv.url}/crash`)).json()) as any).message).toMatch(/^Server error \(request /);
});

test("engine routes win over the host; unhandled paths are a 404; stop disposes the host", async () => {
  expect(await (await fetch(`${srv.url}/rpc/anything`)).text()).not.toContain("the app must not see");
  expect((await fetch(`${srv.url}/nothing-here`)).status).toBe(404);
  expect((await fetch(`${srv.url}/health`)).status).toBe(200);
  await srv.stop({ graceful: false });
  expect(disposed).toBe(true);
});
