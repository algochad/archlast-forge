// The landing page's code samples. `Landing.tsx` imports `snippets` as a Bun macro, so Shiki runs while bundling and none of it ships.
import { highlight } from "../highlight";

const schema = `import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({
  notes: defineTable({
    ownerId: v.id("users"),
    title: v.string(),
    pinned: v.boolean(),
  }).index("by_owner", ["ownerId"]),
});`;

const functions = `import { ForgeError, mutation, query, v } from "@archlast/forge-runtime";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in to use notes");
    return ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("ownerId", me.userId)).take(100);
  },
});

export const add = mutation({
  args: { title: v.string() },
  handler: async (ctx, { title }) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in to use notes");
    return ctx.db.insert("notes", { ownerId: me.userId, title, pinned: false });
  },
});`;

const component = `import { useMutation, useQuery } from "@archlast/forge-react";
import { api } from "../../forge/_generated/api";

export default function Notes() {
  const notes = useQuery(api.notes.list); // undefined once, then live
  const add = useMutation(api.notes.add);
  return (
    <>
      <button onClick={() => add({ title: "New note" })}>Add</button>
      <ul>{notes?.map((n) => <li key={n._id}>{n.title}</li>)}</ul>
    </>
  );
}`;

const hero = `// forge/notes.ts: a query. It runs on the server.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in to use notes");
    return ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("ownerId", me.userId)).take(100);
  },
});`;

const pool = `import { action, v } from "@archlast/forge-runtime";
import { computePool } from "@archlast/forge-runtime/pool";

// Anywhere: no task module, no isMain guard.
const work = computePool({
  digest: (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
});

export const checksum = action({
  args: { url: v.string() },
  handler: async (ctx, { url }) => work.call.digest(new Uint8Array(await (await fetch(url)).arrayBuffer())),
});`;

export function snippets() {
  return {
    hero: highlight("ts", hero),
    schema: highlight("ts", schema, "forge/schema.ts"),
    functions: highlight("ts", functions, "forge/notes.ts"),
    component: highlight("tsx", component, "app/routes/notes.tsx"),
    pool: highlight("ts", pool, "forge/files.ts"),
  };
}
