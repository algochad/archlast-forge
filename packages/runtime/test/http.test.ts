import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { httpAction, httpRouter } from "../src/index";
import { matchRoute } from "../src/server/http";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
let srv: RunningServer;

beforeAll(async () => {
  srv = await startServer({
    forgeDir: fixture,
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json" },
  });
});
afterAll(() => srv.stop({ graceful: false }));

const http = (path: string, init?: RequestInit) => fetch(`${srv.url}/http${path}`, init);

describe("HTTP actions", () => {
  test("GET answers with the handler's status, body and headers", async () => {
    const res = await http("/hello");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("a route answers its own OPTIONS preflight", async () => {
    const res = await http("/hello", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("request bodies cross as bytes, and the handler sees the path it registered", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 0xc3, 0x28]); // not valid UTF-8
    const res = await http("/echo?x=1", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-url")).toBe("/echo?x=1");
  });

  test("a handler can run mutations and queries", async () => {
    const created = (await (await http("/lists", { method: "POST", body: JSON.stringify({ name: "from http" }) })).json()) as any;
    expect(created.id).toMatch(/^lists:/);
    const lists = (await (await http("/lists")).json()) as any[];
    expect(lists.map((l) => l.name)).toContain("from http");
  });

  test("a handler that fails inside a function reports the function's validation error", async () => {
    const res = await http("/lists", { method: "POST", body: JSON.stringify({ name: 5 }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toContain("args.name");
  });

  test("ctx.auth resolves the caller from the cookie", async () => {
    expect(await (await http("/whoami")).json()).toBeNull();
    const signUp = await fetch(`${srv.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: srv.url },
      body: JSON.stringify({ email: "grace@example.com", password: "correct horse battery", name: "Grace" }),
    });
    const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(await (await http("/whoami", { headers: { cookie } })).json()).toMatchObject({ email: "grace@example.com" });
    expect(await (await http("/whoami", { headers: { cookie: "better-auth.session_token=forged" } })).json()).toBeNull();
  });

  test("exact paths beat prefixes; prefixes match everything below them", async () => {
    expect(await (await http("/files/special")).text()).toBe("exact");
    expect(await (await http("/files/a/b.txt")).text()).toBe("prefix:/files/a/b.txt");
  });

  test("404 for unknown paths, 405 with Allow for a known path under another method", async () => {
    expect((await http("/missing")).status).toBe(404);
    expect((await fetch(`${srv.url}/http`)).status).toBe(404);
    const res = await http("/hello", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, OPTIONS");
  });

  test("a Response made from a string keeps the content type the platform gives it", async () => {
    const res = await http("/plain");
    expect(await res.text()).toBe("just text");
    expect(res.headers.get("content-type")).toStartWith("text/plain");
  });

  test("an empty 204 and repeated set-cookie headers survive", async () => {
    const none = await http("/nothing");
    expect(none.status).toBe(204);
    expect(await none.text()).toBe("");
    expect((await http("/cookies")).headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  test("errors: ForgeError data reaches the caller, anything else is hidden outside dev", async () => {
    const forge = await http("/forge-fail");
    expect(forge.status).toBe(400);
    expect(((await forge.json()) as any).error.data).toEqual({ code: "NOPE" });

    const boom = await http("/boom", { headers: { "x-request-id": "req-http-1" } });
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(text).toContain("Server error (request req-http-1)");
    expect(text).not.toContain("secret internal detail");

    const bad = await http("/not-a-response");
    expect(bad.status).toBe(500);
    expect(await bad.text()).not.toContain("must return a Response");
  });
});

describe("httpRouter", () => {
  const h = httpAction(async () => new Response("x"));
  test("rejects malformed routes", () => {
    const r = httpRouter();
    expect(() => r.route({ method: "GET", handler: h })).toThrow("exactly one of path and pathPrefix");
    expect(() => r.route({ method: "GET", path: "a", handler: h })).toThrow('start with "/"');
    expect(() => r.route({ method: "GET", pathPrefix: "/a", handler: h })).toThrow('start and end with "/"');
    expect(() => r.route({ method: "TRACE" as any, path: "/a", handler: h })).toThrow("method must be one of");
    expect(() => r.route({ method: "GET", path: "/a", handler: (() => new Response()) as any })).toThrow("httpAction()");
    r.route({ method: "GET", path: "/a", handler: h });
    expect(() => r.route({ method: "GET", path: "/a", handler: h })).toThrow("Duplicate");
    r.route({ method: "POST", path: "/a", handler: h });
  });

  test("longest prefix wins", () => {
    const r = httpRouter();
    r.route({ method: "GET", pathPrefix: "/a/", handler: h });
    r.route({ method: "GET", pathPrefix: "/a/b/", handler: h });
    const m = matchRoute(r.routes, "GET", "/a/b/c") as any;
    expect(m.route.pathPrefix).toBe("/a/b/");
    expect(matchRoute(r.routes, "GET", "/a")).toEqual({ status: 404 });
  });
});

test("the same holds when the function runtime is a child process (dev)", async () => {
  const child = await startServer({ forgeDir: fixture, dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), RATE_LIMIT_PER_MINUTE: "100000" } });
  try {
    const bytes = new Uint8Array([0, 255, 128, 0xc3, 0x28]);
    const echoed = await fetch(`${child.url}/http/echo`, { method: "POST", body: bytes });
    expect(new Uint8Array(await echoed.arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${child.url}/http/nothing`)).status).toBe(204);
    expect((await fetch(`${child.url}/http/hello`, { method: "PUT" })).headers.get("allow")).toBe("GET, OPTIONS");
  } finally {
    await child.stop({ graceful: false });
  }
});
