import { mutation, query, v } from "../../src/index";

export const list = query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect() });
export const add = mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) });
