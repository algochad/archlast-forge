import { anyApi } from "@archlast/forge-runtime";
import { useQuery } from "@archlast/forge-react";
import type { LoaderArgs } from "@archlast/forge-framework";

const api = anyApi;

/** The last 24 hours, snapped to the minute so that calls in the same minute share a cache entry. */
const lastDay = () => Math.floor((Date.now() - 86_400_000) / 60_000) * 60_000;

export const loader = async ({ ctx }: LoaderArgs) => {
  await ctx.query(api.events.since, { from: lastDay() });
  return null;
};

export default function RangeNaive() {
  const result = useQuery(api.events.since, { from: lastDay() }) as { rows: string[] } | undefined;
  return (
    <main id="range-naive">
      <title>Range (naive)</title>
      <h1>Range, computed in the component</h1>
      <ul id="rows">{result ? result.rows.map((r) => <li key={r}>{r}</li>) : <li id="rows-loading">Loading</li>}</ul>
    </main>
  );
}
