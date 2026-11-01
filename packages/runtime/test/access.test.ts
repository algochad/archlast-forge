import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const admin = { "x-admin-key": "secret", "x-forge-admin": "1", "content-type": "application/json" };
let srv: RunningServer;
type Fixture = "fixture-access" | "fixture-access-plugin";
const modes: Record<"process" | "inline", (fixture: Fixture) => Promise<RunningServer>> = {
  // dev always runs the functions in a child process
  process: (fixture) => startServer({ forgeDir: join(import.meta.dir, fixture), dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "secret" } }),
  // the production default: the functions run inside the server process
  inline: (fixture) =>
    startServer({
      forgeDir: join(import.meta.dir, fixture),
      env: {
        ...process.env,
        PORT: "0",
        DATA_DIR: tempDir(),
        ADMIN_KEY: "secret",
        DASHBOARD: "on",
        BETTER_AUTH_SECRET: "s".repeat(32),
        ALLOW_INSECURE_HTTP: "1",
        RATE_LIMIT_PER_MINUTE: "100000",
        LOG_FORMAT: "json",
      },
    }),
};

// Without a plugin the engine reads the session itself; with one, Better Auth resolves it. Both must keep a session's end and a ban immediate.
describe.each([
  ["process", "fixture-access"],
  ["inline", "fixture-access"],
  ["process", "fixture-access-plugin"],
  ["inline", "fixture-access-plugin"],
] as const)("with the functions running in %s mode (%s)", (mode, fixture) => {
  beforeAll(async () => {
    srv = await modes[mode](fixture);
    expect(srv.config.runtimeMode).toBe(mode);
  });
  afterAll(() => srv.stop({ graceful: false }));

  async function rpc(name: string, input: unknown, opts: { mutation?: boolean; cookie?: string } = {}) {
    const headers = { "content-type": "application/json", ...(opts.cookie && { cookie: opts.cookie }) };
    const res = opts.mutation
      ? await fetch(`${srv.url}/rpc/${name}`, { method: "POST", body: JSON.stringify(input), headers })
      : await fetch(`${srv.url}/rpc/${name}?args=${encodeURIComponent(JSON.stringify(input))}`, { headers });
    const body = (await res.json()) as any;
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  const auth = (path: string, body: object, cookie?: string) =>
    fetch(`${srv.url}/api/auth/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: srv.url, ...(cookie && { cookie }) }, body: JSON.stringify(body) });
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const signUp = async (name: string) => {
    const res = await auth("sign-up/email", { email: `${name}@example.com`, password: "correct horse battery", name });
    return cookieOf(res);
  };
  const cacheFn = async (name: string) => ((await (await fetch(`${srv.url}/_admin/cache`, { headers: admin })).json()) as any).functions.find((f: any) => f.name === name);
  const until = async (cond: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !cond(); await Bun.sleep(10)) if (Date.now() > end) throw new Error("timed out");
  };

  test("a query with access runs once for every caller that passes, and a stranger is refused", async () => {
    const listId = await rpc("todos:createList", { name: "shared" }, { mutation: true });
    await rpc("todos:add", { listId, title: "milk" }, { mutation: true });
    const [ada, bo, cy] = [await signUp("ada"), await signUp("bo"), await signUp("cy")];
    for (const cookie of [ada, bo, cy, ada, bo, cy]) expect(await rpc("todos:sharedList", { listId }, { cookie })).toMatchObject([{ title: "milk" }]);
    const f = await cacheFn("todos:sharedList");
    expect(f).toMatchObject({ misses: 1, perUser: false });
    expect(f.hits).toBe(5);
    await expect(rpc("todos:sharedList", { listId })).rejects.toThrow("Sign in to continue");
    await expect(rpc("todos:sharedList", { listId }, { cookie: "better-auth.session_token=nonsense" })).rejects.toThrow("Sign in to continue");
    // A write still reaches everyone at once.
    await rpc("todos:add", { listId, title: "eggs" }, { mutation: true });
    expect((await rpc("todos:sharedList", { listId }, { cookie: bo })).map((t: any) => t.title)).toEqual(["milk", "eggs"]);
  });

  test("a deactivated user, and a signed-out session, lose access on the very next call", async () => {
    const listId = await rpc("todos:createList", { name: "revoke" }, { mutation: true });
    const [dee, eli] = [await signUp("dee"), await signUp("eli")];
    const me = (await rpc("todos:whoami", {}, { cookie: dee })).userId;
    for (const cookie of [dee, eli, dee, eli]) await rpc("todos:sharedList", { listId }, { cookie }); // both are known to the server now
    await rpc("todos:deactivate", { userId: me }, { mutation: true });
    await expect(rpc("todos:sharedList", { listId }, { cookie: dee })).rejects.toThrow("This account is deactivated");
    expect(await rpc("todos:sharedList", { listId }, { cookie: eli })).toEqual([]); // nobody else is affected
    expect((await auth("sign-out", {}, eli)).status).toBe(200);
    await expect(rpc("todos:sharedList", { listId }, { cookie: eli })).rejects.toThrow("Sign in to continue");
  });

  test("a live subscription to a query with access is cut off when its caller is deactivated", async () => {
    const listId = await rpc("todos:createList", { name: "live" }, { mutation: true });
    const fay = await signUp("fay");
    const me = (await rpc("todos:whoami", {}, { cookie: fay })).userId;
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`, { headers: { cookie: fay, origin: srv.url } } as never);
    const updates: any[] = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "data") updates.push(msg.data);
    });
    await new Promise((r) => ws.addEventListener("open", r));
    ws.send(JSON.stringify({ type: "subscribe", id: "1", name: "todos:sharedList", args: { listId } }));
    await until(() => updates.length === 1);
    expect(updates[0]).toEqual({ value: [] });
    await rpc("todos:add", { listId, title: "one" }, { mutation: true });
    await until(() => updates.length === 2);
    expect(updates[1].value).toMatchObject([{ title: "one" }]);
    await rpc("todos:deactivate", { userId: me }, { mutation: true });
    await until(() => updates.length === 3);
    expect(updates[2].error).toContain("deactivated");
    ws.close();
  });

  test("who is calling is looked up once while the session stands, and again after it changes", async () => {
    const listId = await rpc("todos:createList", { name: "lookups" }, { mutation: true });
    const runtime = srv.runtime as unknown as { identityDetail: (headers: Record<string, string>) => Promise<unknown> };
    const real = runtime.identityDetail.bind(runtime);
    let lookups = 0;
    runtime.identityDetail = (headers) => (lookups++, real(headers));
    try {
      const ivy = await signUp("ivy");
      for (let i = 0; i < 5; i++) await rpc("todos:sharedList", { listId }, { cookie: ivy });
      expect(lookups).toBe(1);
      expect((await auth("sign-out", {}, ivy)).status).toBe(200);
      await expect(rpc("todos:sharedList", { listId }, { cookie: ivy })).rejects.toThrow("Sign in to continue");
      expect(lookups).toBe(2); // the session is gone, so the kept answer was ended by that write and asked again
    } finally {
      runtime.identityDetail = real;
    }
  });

  test("the handler of a query with access can't ask who is calling", async () => {
    const ada = await signUp("gus");
    await expect(rpc("todos:sharedPeek", {}, { cookie: ada })).rejects.toThrow();
  });
});
