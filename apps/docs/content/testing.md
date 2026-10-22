# Testing

`@archlast-forge/runtime/testing` runs your functions against an in-memory database, without a server:

```ts
import { createTestBackend } from "@archlast-forge/runtime/testing";
import { expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";

test("adding a todo", async () => {
  const t = await createTestBackend("convex");
  const ada = await t.withIdentity({ email: "ada@example.com", name: "Ada" });
  const listId = await ada.mutation(api.lists.create, { name: "home" });
  await ada.mutation(api.todos.add, { listId, title: "milk" });
  expect(await t.query(api.todos.listByList, { listId })).toMatchObject([{ title: "milk" }]);

  await t.mutation(internal.todos.scheduleReminder, { listId });
  await t.finishScheduledFunctions(); // runs due jobs as if time had passed
  await t.run(async (ctx) => expect(await ctx.db.query("todos").collect()).toHaveLength(1));
  await t.close();
});
```

- `t.query`, `t.mutation` and `t.action` can call internal functions.
- `withIdentity` creates a user and returns a caller signed in as them.
- `run` gives you direct database access for seeding and assertions.
