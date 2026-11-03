# Testing archlast-forge functions

Read this when you write, change or run tests for `forge/` functions, or need to decide how to test something the test library does not cover (live queries, HTTP routes, sign-in, React components).
Checked against archlast-forge 0.16.0 and Bun 1.4.4. The examples test a small `projects`/`tasks` app shaped like the one in `data-and-functions.md` (`projects.create`, `tasks.add`, `digest.send`, ...); adapt the names to your functions.

## 1. What the library is

`createTestBackend` from `@archlast/forge-runtime/testing` loads your real `forge/` folder against a fresh in-memory SQLite database and lets you call queries, mutations and actions directly: no server, no port, no Docker. Calls go through the engine's own code path: arguments are validated, `returns` is checked, a mutation runs in a transaction that rolls back when it throws, a query reads one snapshot, `ctx.scheduler` really stores jobs. Tests run with `bun test`.

```ts
import {
  createTestBackend,
  type TestBackend,
} from "@archlast/forge-runtime/testing";
import { api, internal } from "../forge/_generated/api";
```

- `createTestBackend(forgeDir = "forge")`: the path is resolved from the directory `bun test` runs in (the project root). An absolute path works (`join(import.meta.dir, "../forge")`, useful in a monorepo).
- Run `archlast-forge codegen` first: your function modules and your tests import `forge/_generated/api`, and `api`/`internal` are what give calls their types.
- Make one backend per test (`beforeEach`/`afterEach`): it costs a few milliseconds and tests cannot affect each other. If you share one per file (`beforeAll`), give every test its own users and data.
- `bun test` does not type-check. To have `tsc` check tests, include `test` in a tsconfig (with `"types": ["bun"]`).

```bash
bun test                              # everything: *.test.ts and *.test.tsx
bun test test/tasks.test.ts           # one file
bun test -t "ownership"               # tests whose name contains this
```

## 2. The test backend

| Call                                                                    | Does                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t.query(ref, args?)`, `t.mutation(ref, args?)`, `t.action(ref, args?)` | call as an anonymous visitor (`ctx.auth.getUserIdentity()` is `null`). **Internal functions can be called too** (`internal.x.y`), which clients cannot                                                      |
| `await t.withIdentity({ email, name?, userId? })`                       | inserts a `users` document (unless `userId` is given) and returns a caller with the same three methods, signed in as that user (`{ userId, sessionId: "test", email, name }`; `name` defaults to the email) |
| `await t.run(async (ctx) => ...)`                                       | runs code in a write transaction with `ctx.db` only (no `auth`, `scheduler`, `storage`): seed data, inspect what functions did. A throw rolls it back                                                       |
| `await t.finishScheduledFunctions(maxRounds = 100)`                     | runs every pending scheduled job, whatever its due time, including jobs they schedule                                                                                                                       |
| `await t.close()`                                                       | closes the database                                                                                                                                                                                         |

`TestBackend` is the type of the object. References are the generated ones, so arguments and results are type-checked; an invalid call (`"nope" as never`) still reaches the engine and fails its validation, which is what you want to assert.

## 3. A test file

```ts
// test/tasks.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createTestBackend,
  type TestBackend,
} from "@archlast/forge-runtime/testing";
import { api, internal } from "../forge/_generated/api";

let t: TestBackend;
beforeEach(async () => {
  t = await createTestBackend("forge");
});
afterEach(() => t.close());

/** A signed-in caller with a project to work in. */
async function setup(email = "ada@example.com") {
  const ada = await t.withIdentity({ email });
  const projectId = await ada.mutation(api.projects.create, { name: "Launch" });
  return { ada, projectId };
}

test("adds tasks and lists the open ones", async () => {
  const { ada, projectId } = await setup();
  await ada.mutation(api.tasks.add, { projectId, title: "Write docs" });
  expect(await ada.query(api.tasks.open, { projectId })).toMatchObject([
    { title: "Write docs", done: false },
  ]);
});

test("a ForgeError reaches the test with its data", async () => {
  const { ada } = await setup();
  const err = await ada
    .mutation(api.projects.create, { name: "Launch" })
    .catch((e) => e);
  expect(err.name).toBe("ForgeError");
  expect(err.data).toEqual({ code: "NAME_TAKEN", name: "Launch" });
  await expect(
    ada.mutation(api.projects.create, { name: " " }),
  ).rejects.toThrow("A project needs a name");
});

test("arguments are validated before the handler runs", async () => {
  const { ada } = await setup();
  await expect(
    ada.mutation(api.tasks.add, { projectId: "nope" as never, title: "x" }),
  ).rejects.toThrow('args.projectId must be an Id<"projects">');
});

test("ownership: another user gets the same answer as for a missing project", async () => {
  const { projectId } = await setup();
  const bob = await t.withIdentity({ email: "bob@example.com" });
  await expect(bob.query(api.tasks.open, { projectId })).rejects.toThrow(
    "No such project",
  );
  await expect(t.query(api.projects.mine)).rejects.toThrow("Sign in first"); // anonymous
});

test("a mutation that throws rolls everything back", async () => {
  const { ada, projectId } = await setup();
  await expect(
    ada.mutation(api.tasks.addMany, { projectId, titles: ["ok", 5 as never] }),
  ).rejects.toThrow();
  expect(await t.run((ctx) => ctx.db.query("tasks").count())).toBe(0); // read the state afterwards
});

test("run() seeds data that no function creates", async () => {
  const { ada, projectId } = await setup();
  await t.run(async (ctx) => {
    await ctx.db.insertMany("tasks", [
      { projectId, title: "Fix login", done: false, priority: 1 },
      { projectId, title: "Fix logout", done: true, priority: 2 },
      { projectId, title: "Write docs", done: false },
    ]);
  });
  expect(
    (await ada.query(api.tasks.board, { projectId })).map((x) => x.title),
  ).toEqual(["Fix login"]);
  expect(await ada.query(api.tasks.stats, { projectId })).toEqual({
    total: 3,
    done: 1,
    avgPriority: 1.5,
  });
});

test("internal functions are callable", async () => {
  const { ada, projectId } = await setup();
  await ada.mutation(api.tasks.add, { projectId, title: "a" });
  const id = (await ada.query(api.tasks.open, { projectId }))[0]!._id;
  await ada.mutation(api.tasks.setDone, { id, done: true });
  expect(await t.mutation(internal.tasks.purgeDone, { projectId })).toBe(1);
});
```

## 4. What to test, and how

| Behaviour                             | How                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization and ownership           | two `withIdentity` callers plus the anonymous `t`; assert the refusal message. Test every public function that takes an id                                                                               |
| Validation                            | call with a bad argument (`as never`) and assert the message (`args.title must be a string, got 5`)                                                                                                      |
| User-facing errors                    | `.rejects.toThrow("message")`, or catch and check `err.name === "ForgeError"` / `err.data` for structured errors                                                                                         |
| Rollback                              | make the mutation throw, then read the state with `t.run`                                                                                                                                                |
| Queries, ordering, pagination, search | seed with `t.run` (`insertMany`), call the query, assert the result. Paginated: pass `{ paginationOpts: { numItems: 10, cursor: null } }`                                                                |
| `access` queries                      | `t.query` as anonymous must reject; a `withIdentity` caller passes                                                                                                                                       |
| Actions                               | stub `fetch`, call `t.action`, assert the calls and the rows the action wrote through `runMutation`                                                                                                      |
| Scheduled work                        | `t.finishScheduledFunctions()`, section 6                                                                                                                                                                |
| Migrations                            | call the migration as an internal mutation, section 8                                                                                                                                                    |
| Logic inside an HTTP route or webhook | keep the `httpAction` thin and move the logic into an `internalMutation` it calls with `ctx.runMutation`; test that with `t.mutation(internal...)`; test the route itself with a real server (section 9) |

## 5. Auth in tests

- `withIdentity` makes a user. Two calls with the same email make two users. To act as the same user again, pass `userId`:
  ```ts
  const user = await t.run((ctx) =>
    ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", "ada@example.com"))
      .unique(),
  );
  const adaAgain = await t.withIdentity({
    email: "ada@example.com",
    userId: user!._id,
  });
  ```
- The anonymous `t` and the callers from `withIdentity` share one database: use them to test that bob cannot touch ada's data.
- Not available: Better Auth itself (no sessions, cookies, sign-up or sign-in routes, plugins). `withIdentity` fakes only `ctx.auth.getUserIdentity()`. Test sign-in flows against a running server or by hand.

## 6. Scheduled functions

`ctx.scheduler.runAfter` and `runAt` store a job in the in-memory database. Nothing runs until you call `await t.finishScheduledFunctions()`: time does not pass on its own.

```ts
// forge/later.ts
export const remind = mutation({
  args: { projectId: v.id("projects"), inMs: v.number() },
  handler: async (ctx, { projectId, inMs }) => {
    await ctx.scheduler.runAfter(inMs, internal.later.mark, { projectId });
  },
});
export const mark = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await ctx.db.insert("tasks", { projectId, title: "reminder", done: false });
  },
});

// test
test("a scheduled reminder is created", async () => {
  const { ada, projectId } = await setup();
  await ada.mutation(api.later.remind, { projectId, inMs: 3_600_000 });
  expect(await t.run((ctx) => ctx.db.query("tasks").count())).toBe(0); // not yet
  await t.finishScheduledFunctions(); // an hour passes
  expect(await t.run((ctx) => ctx.db.query("tasks").count())).toBe(1);
});
```

- Assert the state before, call it, assert after.
- Jobs run as in production: a scheduled mutation exactly once, a scheduled action at most once, both with no user (`getUserIdentity()` is `null`).
- A job that throws is marked failed and `finishScheduledFunctions` does **not** throw: assert on the job's effect. The job table is not readable (`Unknown table "_scheduled_functions"`).
- A job that keeps scheduling another makes it throw `Scheduled functions keep scheduling more; gave up` after `maxRounds`.
- To test one job's logic only, call its function directly: `t.mutation(internal.later.mark, { projectId })`.
- **Crons are not started** by the test backend. Test the cron's target function by calling it, and the schedule through the module's export:
  ```ts
  import crons from "../forge/crons";
  test("crons are registered", () => {
    expect(crons.jobs.map((j) => [j.name, j.fn, j.schedule])).toEqual([
      ["sweep done tasks", "later:sweep", { kind: "interval", ms: 3_600_000 }],
    ]);
  });
  ```

## 7. What to mock

| Thing                                         | How                                                                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch` in actions (payment, email, webhooks) | `spyOn(globalThis, "fetch")` from `bun:test`; restore in `finally`                                                                                                                            |
| `process.env` values (`DIGEST_URL`, API keys) | set before the call, `delete` in `finally`                                                                                                                                                    |
| The clock                                     | `setSystemTime(new Date("2026-01-01T00:00:00Z"))` from `bun:test`, then `setSystemTime()` in `finally` (affects `Date.now()`, hence `runAfter`; `finishScheduledFunctions` ignores the clock) |
| Storage (`ctx.storage`)                       | not available: it throws `Storage is not configured`. Keep storage calls in small functions and test the rest, or run a real server with `STORAGE=local`                                      |
| Authentication                                | `withIdentity`                                                                                                                                                                                |
| The database, the scheduler, validation       | do not mock: they are real and in memory                                                                                                                                                      |

```ts
import { spyOn } from "bun:test"; // next to the other bun:test imports

test("an action calls the digest API once, with the open tasks", async () => {
  const { ada, projectId } = await setup();
  await ada.mutation(api.tasks.add, { projectId, title: "Write docs" });

  process.env.DIGEST_URL = "https://hooks.test/digest";
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    (async () => new Response("{}")) as unknown as typeof fetch,
  );
  try {
    expect(await ada.action(api.digest.send, { projectId })).toEqual({
      sent: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hooks.test/digest");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject([
      { title: "Write docs" },
    ]);
  } finally {
    fetchMock.mockRestore();
    delete process.env.DIGEST_URL;
  }
});
```

Return a new `Response` per call (a body can be read once). A failing provider: `new Response("no", { status: 500 })`, then `await expect(ada.action(...)).rejects.toThrow("Could not send: ...")`.

Errors are not reshaped: a `ForgeError` rejects as a `ForgeError`, validation as `ValidationError`, anything else with its own message. Production would show other callers `Server error (request <id>)`; a test always sees the real message, so it cannot check that a message stays hidden. There are no HTTP statuses or request ids here.

## 8. Testing a migration

A data migration is an internal mutation that handles one batch per call and returns `{ cursor, isDone, processed }`. Seed the old shape with `t.run` (keep the old field in the schema while you test), run it, assert:

```ts
const { projectId } = await setup();
await t.run(
  async (ctx) =>
    void (await ctx.db.insertMany(
      "tasks",
      [1, 2, 3].map((n) => ({ projectId, title: `t${n}`, done: false })),
    )),
);
const result = await t.mutation(internal.migrations.backfillPriority, {
  cursor: null,
});
expect(result).toMatchObject({ isDone: true, processed: 3 });
expect(await t.run((ctx) => ctx.db.query("tasks").sum("priority"))).toBe(0);
```

When `isDone` is false, call again with the returned `cursor`. Run it twice to prove it is idempotent.

## 9. Beyond the library

The library does not cover: live queries and WebSockets (a query is one call), Better Auth, HTTP routes in `forge/http.ts` (not registered), crons, storage, the query cache, rate limits, timeouts, status codes, full-stack pages (loaders, server rendering), and Postgres (SQLite only).

**A running engine** for live updates and HTTP routes: start it inside the test, talk to it with the client or `fetch`. Use anonymous endpoints (the real server needs a Better Auth session for signed-in calls).

```ts
// test/e2e.test.ts  (needs @archlast/forge-client)
// Assumes forge/stats.ts exports an anonymous query `total` (counts rows) and a mutation `record`, and forge/http.ts serves GET /hello.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArchlastForgeClient } from "@archlast/forge-client";
import {
  startServer,
  type RunningServer,
} from "@archlast/forge-runtime/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../forge/_generated/api";

let server: RunningServer;
let client: ArchlastForgeClient;

beforeAll(async () => {
  server = await startServer({
    forgeDir: "forge",
    dev: true, // skips production checks (HTTPS URL, auth secret, schema check)
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: mkdtempSync(join(tmpdir(), "e2e-")),
    }, // a free port and a fresh database
  });
  client = new ArchlastForgeClient({ url: server.url });
});
afterAll(async () => {
  client.close();
  await server.stop();
});

const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(10))
    if (Date.now() > end) throw new Error("timed out");
};

test("a live query follows a mutation", async () => {
  const seen: number[] = [];
  const stop = client.watch(
    api.stats.total,
    {},
    (u) => "value" in u && seen.push(u.value),
  );
  await until(() => seen.length === 1); // the first message is the current result: wait for it before writing
  await client.mutation(api.stats.record, { kind: "signup" });
  await until(() => seen.length === 2);
  stop();
  expect(seen).toEqual([0, 1]);
});

test("an HTTP route", async () => {
  const res = await fetch(`${server.url}/http/hello`);
  expect(res.status).toBe(200);
});

test("a refused call carries a code", async () => {
  const err = await client.query(api.shared.latest).catch((e) => e);
  expect(err.code).toBe("BAD_REQUEST"); // a ForgeError is always 400; err.data holds its data
});
```

Start one server per file, not per test; use new ids per test. Wait on a condition, never a fixed sleep.

**React components**: the hooks use only `watch`, `mutation` and `action` of the client, so give `ArchlastForgeProvider` a small fake client instead of a server (needs `@testing-library/react`, `@happy-dom/global-registrator`, `react`):

```ts
// test/components/fake-client.ts
import type { ArchlastForgeClient, QueryUpdate } from "@archlast/forge-client";
import { getFunctionName } from "@archlast/forge-runtime";

/** Keys are function names ("tasks:open"), as getFunctionName(api.tasks.open) gives. */
export function fakeClient(
  opts: {
    queries?: Record<string, unknown>;
    mutations?: Record<string, (args: any) => unknown>;
  } = {},
) {
  const listeners = new Map<string, Set<(u: QueryUpdate) => void>>();
  const calls: { name: string; args: unknown }[] = [];
  const client = {
    watch(ref: any, _args: unknown, listener: (u: QueryUpdate) => void) {
      const name = getFunctionName(ref);
      (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(
        listener,
      );
      if (name in (opts.queries ?? {}))
        listener({ value: opts.queries![name] });
      return () => listeners.get(name)!.delete(listener);
    },
    async mutation(ref: any, args: unknown) {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      const handler = opts.mutations?.[name];
      if (!handler) throw new Error(`unexpected mutation ${name}`);
      return handler(args);
    },
  } as unknown as ArchlastForgeClient;
  const push = (name: string, update: QueryUpdate) =>
    listeners.get(name)?.forEach((l) => l(update)); // a live update, as after a write
  return { client, calls, push };
}
```

```tsx
// test/components/OpenTasks.test.tsx
// app/OpenTasks.tsx renders useQuery(api.tasks.open, { projectId }) and has a button calling useMutation(api.tasks.add).
import { ArchlastForgeProvider } from "@archlast/forge-react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { OpenTasks } from "../../app/OpenTasks";
import { fakeClient } from "./fake-client";

afterEach(cleanup);

test("renders the live result and follows updates", async () => {
  const fake = fakeClient({
    queries: { "tasks:open": [{ _id: "tasks:1", title: "Write docs" }] },
  });
  render(
    <ArchlastForgeProvider client={fake.client}>
      <OpenTasks projectId={"projects:1" as never} />
    </ArchlastForgeProvider>,
  );
  expect(await screen.findByText("Write docs")).toBeTruthy();
  act(() =>
    fake.push("tasks:open", {
      value: [
        { _id: "tasks:1", title: "Write docs" },
        { _id: "tasks:2", title: "Ship" },
      ],
    }),
  );
  expect(await screen.findByText("Ship")).toBeTruthy();
});
```

`push("name", { error: "...", data: ..., requestId: "..." })` simulates a failing query (the hook throws to the nearest error boundary, a `ForgeError` when `data` is present); a `mutations` handler that throws `new ForgeError("...")` simulates a refused mutation. This tests how a component reacts; the test backend tests what the queries return.

happy-dom replaces global `fetch`, which breaks the real-server tests. Register it only for component tests, never through a global `bunfig.toml` preload:

```bash
bun test --path-ignore-patterns 'test/components/**'   # functions + real server
bun test --preload ./happydom.ts test/components       # components; happydom.ts: GlobalRegistrator.register()
```

## Common mistakes

1. Forgetting `archlast-forge codegen`: the test imports `api` that does not know the new function, or loading `forge/` fails.
2. Sharing one backend across tests and relying on empty tables: another test's rows leak in. Make a backend per test, or unique data per test.
3. Expecting a scheduled job to run without `await t.finishScheduledFunctions()`, or expecting it to throw when the job fails (it does not: assert on the effect).
4. Expecting crons, HTTP routes, storage, Better Auth sign-in, caching or live subscriptions in the test backend. Use a real server (`startServer`) or restructure so the logic is in functions you can call.
5. Hitting the real network from an action test. Stub `fetch`, and restore it (and `process.env`, and `setSystemTime()`) in `finally` so later tests are not affected.
6. Asserting `Server error (request ...)` for a plain `Error`: the test backend throws the real message. Only a running server sanitizes.
7. Testing only the happy path of a public function: also test the anonymous caller, a second user, a wrong id and a bad argument.
8. Forgetting `await` on a call or on `expect(...).rejects`: the test passes without running the assertion.
9. Using `t.run` to call functions: it only gives `ctx.db`. Call functions through `t.query/mutation/action`.
10. Registering happy-dom in a global `bunfig.toml` preload and then wondering why `startServer`/`fetch` tests fail.
11. A migration test that seeds the old shape after the old field was removed from the schema: `t.run` writes are validated, so the seed fails. Keep the old field (optional) in the schema until every environment has migrated.
12. Comparing `_id` or `_creationTime` literally in `toEqual`: use `toMatchObject` on the fields you care about.
