import { expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "../src/index";
import { createTestBackend } from "../src/testing";

const api = anyApi;

test("the testing library runs functions, identities and scheduled work in memory", async () => {
  const t = await createTestBackend(join(import.meta.dir, "fixture"));
  const listId = await t.mutation(api.todos.createList, { name: "home" });
  await t.mutation(api.todos.add, { listId, title: "milk" });
  expect(await t.query(api.todos.listByList, { listId })).toMatchObject([{ title: "milk" }]);
  expect(await t.query(api.todos.whoami)).toBeNull();
  const ada = await t.withIdentity({ email: "ada@example.com", name: "Ada" });
  expect(await ada.query(api.todos.whoami)).toMatchObject({ email: "ada@example.com", userId: expect.stringMatching(/^users:/) });
  await t.mutation(api.todos.scheduleEvent, { kind: "later", delayMs: 60_000 });
  await t.finishScheduledFunctions();
  expect(((await t.query(api.todos.events)) as any[]).map((e) => e.kind)).toEqual(["later"]);
  expect(await t.run(async (ctx) => (await (ctx.db as any).query("lists").collect()).length)).toBe(1);
  expect(await t.run(async (ctx) => (await (ctx.db as any).query("lists").skip(1).collect()).length)).toBe(0);
  // paginationOptsValidator takes numbered pages as well as cursors.
  expect(await t.query(api.todos.todosPage, { listId, paginationOpts: { numItems: 5, cursor: null, offset: 0, withTotal: true } })).toMatchObject({
    page: [{ title: "milk" }],
    isDone: true,
    total: 1,
  });
  expect(await t.query(api.todos.todosPage, { listId, paginationOpts: { numItems: 5, cursor: null, offset: 1 } })).toMatchObject({ page: [], isDone: true });
  await t.close();
});

test("a query with access checks the caller in the testing library too, and its handler can't ask who is calling", async () => {
  const t = await createTestBackend(join(import.meta.dir, "fixture"));
  const listId = await t.mutation(api.todos.createList, { name: "shared" });
  await t.mutation(api.todos.add, { listId, title: "milk" });
  await expect(t.query(api.todos.sharedList, { listId })).rejects.toThrow("Sign in to continue");
  const ada = await t.withIdentity({ email: "ada@example.com", name: "Ada" });
  expect(await ada.query(api.todos.sharedList, { listId })).toMatchObject([{ title: "milk" }]);
  await expect(ada.query(api.todos.sharedPeek)).rejects.toThrow("declares access");
  await t.close();
});

test("withIdentity makes a real session, with the fields a plugin keeps on it (an active organization)", async () => {
  const t = await createTestBackend(join(import.meta.dir, "fixture"));
  const ada = await t.withIdentity({ email: "ada@example.com", session: { activeOrganizationId: "organizations:abc" } });
  const me = (await ada.query(api.todos.whoami)) as { sessionId: string; userId: string };
  expect(me.sessionId).toMatch(/^sessions:/);
  const session = await t.run(async (ctx) => (ctx.db as any).get(me.sessionId));
  expect(session).toMatchObject({ userId: me.userId, activeOrganizationId: "organizations:abc" });
  await t.close();
});
