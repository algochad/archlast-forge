import { useNow, useTimeZone, type LoaderArgs } from "@archlast/forge-framework";
import { useQuery } from "@archlast/forge-react";
import { anyApi } from "@archlast/forge-runtime";

const api = anyApi;

export const loader = async ({ ctx }: LoaderArgs) => {
  await ctx.query(api.events.admission);
  return null;
};

export default function Times() {
  const admission = useQuery(api.events.admission) as { admittedAt: number } | undefined;
  const timeZone = useTimeZone();
  const now = useNow();
  if (!admission) return <p id="loading">Loading</p>;
  const at = admission.admittedAt;
  return (
    <main id="times">
      <title>Times</title>
      <h1>Times</h1>
      <p id="when">{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(at)}</p>
      <p id="zone">{timeZone}</p>
      <p id="stay">Day {Math.floor((now - at) / 86_400_000) + 1}</p>
    </main>
  );
}
