import { useLoaderData, type LoaderArgs } from "@archlast/forge-framework";
import { useQuery } from "@archlast/forge-react";
import { anyApi } from "@archlast/forge-runtime";

const api = anyApi;

/** The last 24 hours, snapped to the minute so that calls in the same minute share a cache entry. */
const lastDay = () => Math.floor((Date.now() - 86_400_000) / 60_000) * 60_000;

// Worked out once, here, and handed to the page: the server's render and the browser's both use this value, whatever their clocks say.
export const loader = async ({ ctx }: LoaderArgs) => {
  const from = lastDay();
  await ctx.query(api.events.since, { from });
  return { from };
};

export default function Range() {
  const { from } = useLoaderData<typeof loader>();
  const result = useQuery(api.events.since, { from }) as { rows: string[] } | undefined;
  return (
    <main id="range">
      <title>Range</title>
      <h1>Range</h1>
      <ul id="rows">{result ? result.rows.map((r) => <li key={r}>{r}</li>) : <li id="rows-loading">Loading</li>}</ul>
    </main>
  );
}
