import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { nativeEngine } from "../src/server/engine";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

// /http on the native engine is answered from the engine's own request (server.ts: rawHttp), not through a Web Request: the same answers, the same telemetry,
// the same rate limits and security headers as the path below it.
const fixture = join(import.meta.dir, "fixture");
const ADMIN = "k".repeat(32);
let native = false;
let srv: RunningServer;
let limited: RunningServer;
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

const start = (env: Record<string, string>, dev = false) =>
  startServer({ forgeDir: fixture, dev, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", LOG_FORMAT: "json", HTTP_ENGINE: "archlast", ADMIN_KEY: ADMIN, ...env } });

beforeAll(async () => {
  native = (await nativeEngine()) !== null;
  if (!native) return;
  srv = await start({ RATE_LIMIT_PER_MINUTE: "100000", RUNTIME_MODE: "process" }, true); // development: the admin API, and the function runtime in a process of its own
  limited = await start({ RATE_LIMIT_PER_MINUTE: "3" });
}, 30_000);
afterAll(async () => {
  await srv?.stop({ graceful: false });
  await limited?.stop({ graceful: false });
});

const http = (path: string, init?: RequestInit) => fetch(`${srv.url}/http${path}`, init);
const get = async (op: string, input: object = {}) => {
  const r = await fetch(`${srv.url}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "x-admin-key": ADMIN } });
  const body = (await r.json()) as any;
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(body)}`);
  return body;
};
const eventually = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 40) => {
  let v = await read();
  for (let i = 0; i < tries && !ok(v); i++) v = (await Bun.sleep(150), await read());
  return v;
};

describe("/http on the native engine", () => {
  test("answers as the handler said, with the request id", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const res = await http("/hello");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    // a request id the caller sent is kept; one that is not an id is replaced
    expect((await http("/hello", { headers: { "x-request-id": "mine-1" } })).headers.get("x-request-id")).toBe("mine-1");
    expect((await http("/hello", { headers: { "x-request-id": "no spaces allowed" } })).headers.get("x-request-id")).not.toBe("no spaces allowed");
  });

  test("a body that is not text crosses as the bytes it is, with the query string and path the handler registered", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 0xc3, 0x28]);
    const res = await http("/echo?x=1&y=two", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("x-url")).toBe("/echo?x=1&y=two");
  });

  test("a route answers its own preflight, a missing route is a 404 and a wrong method a 405", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    expect((await http("/hello", { method: "OPTIONS" })).status).toBe(204);
    expect((await http("/no-such-route")).status).toBe(404);
    expect((await http("/hello", { method: "DELETE" })).status).toBe(405);
  });

  test("the caller is resolved from the cookie, as on the Web path", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    expect(await (await http("/whoami")).json()).toBeNull();
    const signUp = await fetch(`${srv.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: srv.url },
      body: JSON.stringify({ email: "native@example.com", password: "correct horse battery", name: "Nat" }),
    });
    const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(((await (await http("/whoami", { headers: { cookie } })).json()) as any).name).toBe("Nat");
  });

  test("requests are counted and traced under their route, and a trace the caller started continues", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    await http("/hello");
    await http("/hello", { headers: { traceparent: `00-${TRACE}-00f067aa0ba902b7-01` } });
    const ops = await eventually(
      () => get("obs.requests", { from: Date.now() - 3600_000, to: Date.now() + 60_000 }),
      (r) => r.operations.some((o: any) => o.kind === "http" && o.operation === "GET /hello"),
    );
    expect(ops.operations.find((o: any) => o.kind === "http" && o.operation === "GET /hello")).toBeTruthy();
    const trace = await eventually(
      () => get("obs.trace", { traceId: TRACE }),
      (t) => Boolean(t?.spans?.length),
    );
    expect(trace.spans.map((s: any) => s.name)).toContain("GET /hello");
  });

  test("the rate limit applies, with the request id on the refusal", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const hit = () => fetch(`${limited.url}/http/hello`);
    const answers = [await hit(), await hit(), await hit(), await hit()];
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 429]);
    expect(answers[3]!.headers.get("retry-after")).toBeTruthy();
    expect(answers[3]!.headers.get("x-request-id")).toBeTruthy();
  });
});
