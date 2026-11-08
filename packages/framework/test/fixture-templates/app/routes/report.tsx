import { useLoaderData } from "@archlast/forge-framework";
import { useMemo } from "react";
import { Bar } from "../_c/bar";

export async function loader() {
  return {
    q: 'sales "Q3" & <more>',
    html: "<em>raw</em> &amp; kept",
    rows: [
      { label: "North", pct: 62.5, share: 0.1 + 0.2, big: 1e21, tiny: 1.5e-7, neg: -0.000001 },
      { label: "South", pct: 0, share: 1 / 3, big: 123456789012345680000, tiny: 0.0000001, neg: -2.5e-10 },
      { label: "East", pct: 100, share: 2e-6, big: 5e-324, tiny: 100, neg: 7 },
    ],
  };
}

export default function Report() {
  const { q, html, rows } = useLoaderData<typeof loader>();
  const total = useMemo(() => rows.length * 2, [rows]);
  return (
    <main id="report">
      <form action="/report" method="get" className="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search" />
        <input type="checkbox" name="all" defaultChecked />
        <button type="submit">Go</button>
      </form>
      <p dangerouslySetInnerHTML={{ __html: html }} />
      <p id="total">{total} cells</p>
      {rows.map((r) => (
        <div key={r.label}>
          <Bar label={r.label} pct={r.pct} />
          <Bar label="fixed" pct={10} tone="hot" />
          <span>
            {r.share} {r.big} {r.tiny} {r.neg}
          </span>
        </div>
      ))}
    </main>
  );
}
