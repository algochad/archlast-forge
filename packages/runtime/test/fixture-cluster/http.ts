import { httpRouter, lightAction, lightJson } from "../../src/index";

const http = httpRouter();
/** Which server of the cluster answered: the first characters of its request ids differ from server to server. */
http.route({ method: "GET", path: "/who", handler: lightAction(async () => lightJson({ index: Number(process.env.ARCHLAST_CLUSTER_INDEX ?? 0), pid: process.pid })) });
http.route({
  method: "POST",
  path: "/inc",
  handler: lightAction(async (ctx) =>
    lightJson(
      await ctx.write(async (c) => {
        const db = c.db as any;
        const row = await db.query("counters").withIndex("by_name", (q: any) => q.eq("name", "hits")).first();
        if (!row) return db.insert("counters", { name: "hits", n: 1 });
        await db.patch(row._id, { n: row.n + 1 });
        return row._id;
      }),
    ),
  ),
});
http.route({
  method: "GET",
  path: "/count",
  handler: lightAction(async (ctx) => lightJson(await ctx.read(async (c) => ((await (c.db as any).query("counters").withIndex("by_name", (q: any) => q.eq("name", "hits")).first())?.n ?? 0)))),
});
/** A document of about 16 KB, to grow the write-ahead log. */
http.route({
  method: "POST",
  path: "/big",
  handler: lightAction(async (ctx) => lightJson(await ctx.write(async (c) => (c.db as any).insert("blobs", { text: "x".repeat(16_000) })))),
});
export default http;
