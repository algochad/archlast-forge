import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { loadProject } from "../src/server/project";
import { tempDir } from "./helpers";

// forge/http.ts with httpRouter({ root: true }): its routes answer at the root as well as under /http, after the engine's own paths.
const fixture = join(import.meta.dir, "fixture-root");
// In a child process: one Nest app per process, and nest.test.ts mounts its own inline. It also carries the routes across the pipe.
const env = () => ({ ...process.env, RUNTIME_MODE: "process", PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json" });

describe("a backend", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ forgeDir: fixture, env: { ...env(), API_DOCS: "1" } });
  });
  afterAll(() => srv.stop({ graceful: false }));

  test("a route answers at its own path, and the handler sees that path", async () => {
    const res = await fetch(`${srv.url}/api/v1/hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world", path: "/api/v1/hello" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("it still answers under /http", async () => {
    expect(await (await fetch(`${srv.url}/http/api/v1/hello`)).json()).toEqual({ hello: "world", path: "/api/v1/hello" });
  });

  test("bodies reach a root route, and another method on its path answers 405", async () => {
    const res = await fetch(`${srv.url}/webhooks/stripe`, { method: "POST", body: "signed body" });
    expect(await res.text()).toBe("signed body");
    expect((await fetch(`${srv.url}/webhooks/stripe`, { method: "PUT" })).status).toBe(405);
  });

  test("Nest controllers answer below their prefix at the root", async () => {
    const res = await fetch(`${srv.url}/api/v2/tasks/7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "7", from: "nest" });
  });

  test("a prefix of / takes what the engine doesn't own, and the engine keeps its paths", async () => {
    expect(await (await fetch(`${srv.url}/anything/else`)).text()).toBe("catch-all /anything/else");
    expect((await fetch(`${srv.url}/health`)).status).toBe(200);
    expect(await (await fetch(`${srv.url}/api/auth/ok`)).json()).toEqual({ ok: true });
    const rpc = await fetch(`${srv.url}/rpc/nothing:here`, { method: "POST", body: "{}" });
    expect(rpc.status).toBe(404);
    expect(await rpc.text()).not.toContain("catch-all");
  });

  test("the OpenAPI document describes the routes where they answer", async () => {
    const doc = (await (await fetch(`${srv.url}/_api/openapi.json`)).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/api/v1/hello");
    expect(Object.keys(doc.paths)).toContain("/webhooks/stripe");
    expect(Object.keys(doc.paths)).toContain("/api/v2/tasks/{id}");
    expect(Object.keys(doc.paths).some((p) => p.startsWith("/http/"))).toBe(false);
  });
});

describe("a full-stack app", () => {
  let srv: RunningServer;
  let warned: string[] = [];
  beforeAll(async () => {
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.join(" ")));
    srv = await startServer({
      forgeDir: fixture,
      env: env(),
      app: { fetch: (req) => new Response(`page ${new URL(req.url).pathname}`) },
    });
    await fetch(`${srv.url}/api/v1/hello`); // the first match reads the routes
    warn.mockRestore();
  });
  afterAll(() => srv.stop({ graceful: false }));

  test("routes answer at the root and the pages get every other path", async () => {
    expect(await (await fetch(`${srv.url}/api/v1/hello`)).json()).toEqual({ hello: "world", path: "/api/v1/hello" });
    expect(await (await fetch(`${srv.url}/api/v2/tasks/1`)).json()).toEqual({ id: "1", from: "nest" });
    expect(await (await fetch(`${srv.url}/about`)).text()).toBe("page /about");
    expect(await (await fetch(`${srv.url}/`)).text()).toBe("page /");
  });

  test("a route for every path stays under /http, with a warning", async () => {
    expect(await (await fetch(`${srv.url}/http/about`)).text()).toBe("catch-all /about");
    expect(warned.join("\n")).toContain("which would hide the app's pages");
  });
});

test("a root route inside one of the engine's paths is refused when the code loads", async () => {
  const dir = tempDir();
  const src = join(import.meta.dir, "../src/index.ts");
  await Bun.write(join(dir, "schema.ts"), `import { defineSchema } from ${JSON.stringify(src)};\nexport default defineSchema({});\n`);
  await Bun.write(
    join(dir, "http.ts"),
    `import { httpAction, httpRouter } from ${JSON.stringify(src)};
const http = httpRouter({ root: true });
http.route({ method: "GET", path: "/rpc/mine", handler: httpAction(async () => new Response("x")) });
export default http;
`,
  );
  await expect(loadProject(dir)).rejects.toThrow("/rpc is the engine's");
});
