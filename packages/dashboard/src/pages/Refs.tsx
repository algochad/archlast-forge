import { get, type Admin, type Doc, type Manifest } from "../api";
import { Icon } from "../brand";
import { idsOf, incomingOf, labelOf, refsOf, type Go } from "../relations";
import { Badge, Button, useAsync } from "../ui";
import type { Draft } from "./CustomFunction";

/** The documents these ids point at, fetched together; `undefined` until they arrive, `null` for ones that no longer exist. */
export function useResolved(ids: string[]) {
  const key = [...new Set(ids)].sort().slice(0, 200).join(",");
  return useAsync(() => (key ? get<Record<string, Doc | null>>("docsByIds", { ids: key.split(",") }) : Promise.resolve({} as Record<string, Doc | null>)), [key]).data;
}

const tableOf = (id: string) => id.split(":")[0]!;

/** Links to the documents a reference field points at, named by what they are rather than their ids. */
export function RefChips({ ids, docs, go, max = 3 }: { ids: string[]; docs?: Record<string, Doc | null>; go?: Go; max?: number }) {
  if (!ids.length) return <span className="faint">—</span>;
  return (
    <span className="ref-chips">
      {ids.slice(0, max).map((id) => {
        const doc = docs?.[id];
        const missing = docs !== undefined && doc === null;
        const label = labelOf(doc, id);
        const inner = (
          <>
            <Icon name="link" size={12} />
            <span>{missing ? "missing" : label}</span>
            <small className="ref-table">{tableOf(id)}</small>
          </>
        );
        // Without somewhere to go (a query result) it's just a named label.
        if (!go)
          return (
            <span key={id} className="ref-chip static" title={id}>
              {inner}
            </span>
          );
        return (
          <button
            key={id}
            type="button"
            className={`ref-chip ${missing ? "missing" : ""}`}
            disabled={missing}
            title={missing ? `${id} no longer exists` : `Open ${id}`}
            onClick={(e) => {
              e.stopPropagation(); // not also the row's own click
              go({ table: tableOf(id), openId: id, label: `${tableOf(id)} · ${label}` });
            }}
          >
            {inner}
          </button>
        );
      })}
      {ids.length > max && <span className="muted small">+{ids.length - max}</span>}
    </span>
  );
}

type Reference = { table: string; field: string; many: boolean; index: string | null; count: number | null };

/** In a document's drawer: what it points at, and what points at it, each a click away. */
export function Relationships({ table, doc, manifest, go, onQuery }: { table: string; doc: Doc; manifest: Manifest; admin: Admin; go: Go; onQuery?: (draft: Draft) => void }) {
  const info = manifest.tables[table]!;
  const outgoing = refsOf(info).filter((r) => idsOf(doc[r.field]).length);
  const incoming = incomingOf(manifest, table);
  const docs = useResolved(outgoing.flatMap((r) => idsOf(doc[r.field])));
  const counts = useAsync(() => get<Reference[]>("references", { id: doc._id }), [doc._id]).data;
  if (!refsOf(info).length && !incoming.length) return null;
  const label = labelOf(doc, doc._id);

  return (
    <section className="relationships" aria-label="Relationships">
      <h3>
        <Icon name="link" size={15} /> Relationships
      </h3>
      {outgoing.length > 0 && (
        <div className="rel-block">
          <h4>References</h4>
          {outgoing.map((r) => (
            <div key={r.field} className="rel-row">
              <span className="rel-name">
                <code>{r.field}</code>
                <span className="muted small">→ {r.target}</span>
              </span>
              <RefChips ids={idsOf(doc[r.field])} docs={docs} go={go} max={6} />
            </div>
          ))}
        </div>
      )}
      {incoming.length > 0 && (
        <div className="rel-block">
          <h4>Referenced by</h4>
          {incoming.map((r) => {
            const found = counts?.find((c) => c.table === r.table && c.field === r.field);
            const count = found?.count;
            return (
              <div key={`${r.table}.${r.field}`} className="rel-row">
                <span className="rel-name">
                  <code>
                    {r.table}.{r.field}
                  </code>
                  {r.many && <Badge>array</Badge>}
                </span>
                <span className="rel-actions">
                  <span className="count" aria-label={count === undefined ? "counting" : count === null ? "too many to count" : `${count} documents`}>
                    {count === undefined ? "…" : count === null ? "many" : count.toLocaleString()}
                  </span>
                  {r.index ? (
                    <Button
                      variant="ghost"
                      disabled={count === 0}
                      onClick={() => go({ table: r.table, filter: { index: r.index!, eq: [[r.field, doc._id]] }, label: `${r.table} · ${r.field} = ${label}` })}
                    >
                      Browse
                    </Button>
                  ) : (
                    <>
                      <Badge tone="warn">no index</Badge>
                      {onQuery && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            onQuery({
                              code: `// "${r.table}.${r.field}" has no index, so this scans the table. Add .index("by_${r.field}", ["${r.field}"]) to look these up fast.
export default query({
  handler: async (ctx) => {
    return await ctx.db
      .query("${r.table}")
      .filter((d) => ${r.many ? `d.${r.field}?.includes("${doc._id}")` : `d.${r.field} === "${doc._id}"`})
      .take(50);
  },
});
`,
                              args: "{}",
                            })
                          }
                        >
                          Query
                        </Button>
                      )}
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
