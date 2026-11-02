import { query, v } from "@archlast/forge-runtime";

/** About `ms` of CPU work: the kind of query more processes help (a light one mostly pays the hop to a process). */
export const compute = query({
  args: { ms: v.number(), seq: v.number() },
  handler: (_ctx, { ms, seq }) => {
    const until = performance.now() + ms;
    let x = seq;
    while (performance.now() < until) x = (x * 1103515245 + 12345) % 2147483648;
    return x;
  },
});
