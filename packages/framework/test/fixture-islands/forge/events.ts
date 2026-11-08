import { query, v } from "@archlast/forge-runtime";

/** 2026-10-21 22:00 UTC: 15:00 on that day in Los Angeles, 06:00 the next morning in Manila. */
export const ADMITTED = Date.UTC(2026, 9, 21, 22, 0, 0);

export const admission = query({ handler: () => ({ admittedAt: ADMITTED }) });

/** What a "last 24 hours" screen asks: the window starts at an argument the caller worked out from the clock. */
export const since = query({
  args: { from: v.number() },
  handler: (_ctx, { from }) => ({ from, rows: ["first", "second", "third"] }),
});
