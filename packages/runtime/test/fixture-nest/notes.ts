import { mutation, query, v } from "../../src/index";
import { inject } from "../../src/nest";
import { Clock, Counter, NotesReader, NotesWriter } from "./notes.service";

export const list = query({ args: {}, handler: async (ctx) => (await inject(ctx, NotesReader)).list() });
export const add = mutation({ args: { text: v.string() }, handler: async (ctx, { text }) => (await inject(ctx, NotesWriter)).add(text) });

/** Within one call, request-scoped services are shared (the writer's reader is the reader); singletons are one instance across calls. */
export const scopes = mutation({
  args: {},
  handler: async (ctx) => {
    const writer = await inject(ctx, NotesWriter);
    return { shared: writer.reader === (await inject(ctx, NotesReader)), clock: (await inject(ctx, Clock)).id };
  },
});

export const wrongCtx = query({
  args: {},
  handler: async (ctx) => {
    // @ts-expect-error a query's ctx cannot write, so it cannot have a writer
    await inject(ctx, NotesWriter);
  },
});

export const count = query({ args: {}, handler: async (ctx) => (await inject(ctx, Counter)).count() });
