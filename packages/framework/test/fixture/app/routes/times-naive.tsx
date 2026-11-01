import { anyApi } from "@archlast/forge-runtime";
import { useQuery } from "@archlast/forge-react";
import type { LoaderArgs } from "@archlast/forge-framework";

const api = anyApi;

export const loader = async ({ ctx }: LoaderArgs) => {
  await ctx.query(api.events.admission);
  return null;
};

export default function TimesNaive() {
  const admission = useQuery(api.events.admission) as { admittedAt: number } | undefined;
  if (!admission) return <p id="loading">Loading</p>;
  const at = admission.admittedAt;
  return (
    <main id="times-naive">
      <title>Times (naive)</title>
      <h1>Times, formatted the obvious way</h1>
      {/* The machine's zone: what date-fns format() or toLocaleString() give without a zone. */}
      <p id="when">{new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
      {/* The clock: length of stay, read while rendering. */}
      <p id="stay">Day {Math.floor((Date.now() - at) / 86_400_000) + 1}</p>
    </main>
  );
}
