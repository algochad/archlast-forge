import { useEffect, useState } from "react";
import { canWrite, formatTime, get, post, typeOf, type Admin, type Doc, type Manifest, type Page, type TableInfo } from "../api";
import { Icon } from "../brand";
import { idsOf, refsOf, type Go, type Place } from "../relations";
import { CustomFunction, examples, readTable, type Draft } from "./CustomFunction";
import { RefChips, Relationships, useResolved } from "./Refs";
import { RelationsView, TableRelations } from "./Relations";
import { Badge, Button, Code, Drawer, Empty, ErrorNote, Field, JsonEditor, JsonView, Segmented, Skeleton, useAction, useAsync } from "../ui";

/** A filter value: JSON when it parses (numbers, booleans), otherwise the text itself. */
const parseValue = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const builtIn = (name: string, t: TableInfo) => !t.strict || name.startsWith("_");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

type Tool = { kind: "runner"; key: number; initial?: Draft } | { kind: "relations" };

export function Data({ manifest, admin }: { manifest: Manifest; admin: Admin }) {
  const tables = Object.keys(manifest.tables);
  const counts = useAsync(() => get<Record<string, number>>("counts", { tables }), [tables.join()], { interval: 10_000 });
  // Where you are, and the places you followed relationships from to get here. `nonce` restarts the table view on every move.
  const [trail, setTrail] = useState<Place[]>(() => {
    const table = localStorage.getItem("afx:table") ?? tables[0] ?? "";
    return [{ table, label: table }];
  });
  const [nonce, setNonce] = useState(0);
  const [tool, setTool] = useState<Tool | null>(null);
  const here = trail.at(-1)!;
  const table = here.table;
  useEffect(() => localStorage.setItem("afx:table", table), [table]);
  const move = (next: Place[]) => {
    setTrail(next);
    setNonce((n) => n + 1);
    setTool(null);
  };
  const go: Go = (to) => move([...trail, { ...to, label: to.label ?? to.table }]);
  const openTable = (t: string) => move([{ table: t, label: t }]);
  const openRunner = (initial?: Draft) => setTool({ kind: "runner", key: Date.now(), initial });
  const owner = admin.role === "owner";
  if (!tables.length) return <Empty icon="data">No tables yet. Define them in convex/schema.ts.</Empty>;
  const groups = [
    {
      label: "Your tables",
      names: tables.filter((t) => !builtIn(t, manifest.tables[t]!)),
    },
    {
      label: "Built in",
      names: tables.filter((t) => builtIn(t, manifest.tables[t]!)),
    },
  ].filter((g) => g.names.length);
  return (
    <div className="split">
      <nav className="panel list" aria-label="Tables">
        <div className="list-group">
          <span className="list-head">Tools</span>
          <button aria-current={tool?.kind === "relations"} onClick={() => setTool(tool?.kind === "relations" ? null : { kind: "relations" })}>
            <span className="list-name">
              <Icon name="graph" size={15} />
              Relationships
            </span>
          </button>
          <button aria-current={tool?.kind === "runner"} onClick={() => (tool?.kind === "runner" ? setTool(null) : openRunner())}>
            <span className="list-name">
              <Icon name="functions" size={15} />
              Run function
            </span>
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.label} className="list-group">
            <span className="list-head">{g.label}</span>
            {g.names.map((t) => (
              <button key={t} aria-current={!tool && t === table} onClick={() => openTable(t)}>
                <span className="list-name">
                  <Icon name="data" size={15} />
                  {t}
                </span>
                <span className="muted">{counts.data?.[t]?.toLocaleString() ?? ""}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="main-col">
        {tool?.kind === "runner" ? (
          <CustomFunction key={tool.key} manifest={manifest} admin={admin} initial={tool.initial} />
        ) : tool?.kind === "relations" ? (
          <RelationsView
            manifest={manifest}
            counts={counts.data}
            onOpenTable={openTable}
            onQuery={owner ? () => openRunner(examples(manifest).find((e) => e.label === "Join tables")?.draft) : undefined}
          />
        ) : manifest.tables[table] ? (
          <>
            {trail.length > 1 && (
              <nav className="crumbs" aria-label="Where you came from">
                <Button variant="ghost" onClick={() => move(trail.slice(0, -1))}>
                  ← Back
                </Button>
                {trail.map((p, i) => (
                  <span key={i} className="crumb-item">
                    {i > 0 && <span className="faint">›</span>}
                    {i === trail.length - 1 ? (
                      <span className="crumb current" aria-current="location">
                        {p.label}
                      </span>
                    ) : (
                      <button className="crumb" onClick={() => move(trail.slice(0, i + 1))}>
                        {p.label}
                      </button>
                    )}
                  </span>
                ))}
              </nav>
            )}
            <TableView
              key={`${table}:${nonce}`}
              table={table}
              place={here}
              manifest={manifest}
              admin={admin}
              count={counts.data?.[table]}
              onChange={counts.reload}
              go={go}
              onQuery={owner ? (draft) => openRunner(draft ?? readTable(table)) : undefined}
            />
          </>
        ) : (
          <Empty icon="data">Pick a table.</Empty>
        )}
      </div>
    </div>
  );
}

/** Columns in schema order: _id, declared fields, anything undeclared, then _creationTime. */
const orderColumns = (info: TableInfo, docs: Doc[]) => {
  const declared = Object.keys(info.fields);
  const extra = [...new Set(docs.flatMap((d) => Object.keys(d)))].filter((c) => c !== "_id" && c !== "_creationTime" && !declared.includes(c));
  return ["_id", ...declared, ...extra, "_creationTime"];
};

function TableView({
  table,
  place,
  manifest,
  admin,
  count,
  onChange,
  go,
  onQuery,
}: {
  table: string;
  place: Place;
  manifest: Manifest;
  admin: Admin;
  count?: number;
  onChange: () => void;
  go: Go;
  onQuery?: (draft?: Draft) => void;
}) {
  const info = manifest.tables[table]!;
  const indexes = ["by_creation_time", ...Object.keys(info.indexes)];
  const [view, setView] = useState<"documents" | "schema">("documents");
  // Arriving from a relationship can mean arriving with a lookup already applied.
  const [index, setIndex] = useState(place.filter?.index ?? "by_creation_time");
  const [eqDraft, setEqDraft] = useState<string[]>(() => (place.filter?.eq ?? []).map(([, v]) => (typeof v === "string" ? v : JSON.stringify(v))));
  const [eq, setEq] = useState<[string, unknown][]>(place.filter?.eq ?? []);
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Doc | "new" | null>(null);
  const fields = index === "by_creation_time" ? [] : info.indexes[index]!;
  const cursor = cursors.at(-1) ?? null;
  const docs = useAsync(
    () =>
      get<Page>("docs", {
        table,
        index: index === "by_creation_time" ? undefined : index,
        eq,
        order,
        cursor,
        numItems: 50,
      }),
    [table, index, JSON.stringify(eq), order, cursor],
    { interval: 4000 },
  );
  const page = docs.data?.page ?? [];
  const columns = orderColumns(info, page);
  // Reference fields show the documents they point at, by name, as links.
  const refs = new Map(refsOf(info).map((r) => [r.field, r]));
  const resolved = useResolved(page.flatMap((d) => [...refs.keys()].flatMap((f) => idsOf(d[f]))));
  // Arrived by following a link to a document: open it.
  useEffect(() => {
    if (!place.openId) return;
    void get<Record<string, Doc | null>>("docsByIds", { ids: [place.openId] }).then((r) => r[place.openId!] && setSelected(r[place.openId!]!));
  }, []);
  const reset = () => setCursors([null]);
  const indexCount = Object.keys(info.indexes).length + Object.keys(info.searchIndexes ?? {}).length;
  const typeLabel = (c: string) => (c === "_id" ? "id" : c === "_creationTime" ? "timestamp" : info.fields[c] ? typeOf(info.fields[c]) : "not in schema");
  const goTo: Go = (to) => {
    setSelected(null);
    go(to);
  };
  const clearFilter = () => {
    setEqDraft([]);
    setEq([]);
    reset();
  };

  return (
    <section className="panel table-view" aria-label={`${table} table`}>
      <header className="table-head">
        <span className="table-icon">
          <Icon name="data" size={20} />
        </span>
        <div className="table-title">
          <h2>{table}</h2>
          <p className="muted small">
            {count === undefined ? "…" : plural(count, "document")} · {plural(Object.keys(info.fields).length, "field")} · {plural(indexCount, "index", "indexes")}
          </p>
        </div>
        {!info.strict && <Badge tone="accent">Better Auth</Badge>}
        <span className="push" />
        <Segmented
          label="View"
          value={view}
          options={[
            { value: "documents", label: "Documents" },
            { value: "schema", label: "Schema" },
          ]}
          onChange={setView}
        />
        {onQuery && (
          <Button variant="ghost" onClick={() => onQuery()}>
            <Icon name="functions" size={16} /> Query
          </Button>
        )}
        {canWrite(admin) && (
          <Button onClick={() => setSelected("new")}>
            <Icon name="plus" size={16} /> Add document
          </Button>
        )}
      </header>

      {view === "schema" ? (
        <div className="table-body schema">
          <SchemaView table={table} info={info} manifest={manifest} onOpenTable={(t) => go({ table: t })} />
        </div>
      ) : (
        <>
          <form
            className="filter-bar"
            onSubmit={(e) => {
              e.preventDefault();
              setEq(fields.slice(0, eqDraft.filter((v) => v !== "").length).map((f, i) => [f, parseValue(eqDraft[i]!)]));
              reset();
            }}
          >
            <Field label="Index">
              {(id) => (
                <select
                  id={id}
                  value={index}
                  onChange={(e) => {
                    setIndex(e.target.value);
                    clearFilter();
                  }}
                >
                  {indexes.map((i) => (
                    <option key={i} value={i}>
                      {i === "by_creation_time" ? "by_creation_time (default)" : `${i} · ${info.indexes[i]!.join(", ")}`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {fields.map((f, i) => (
              <Field key={f} label={`${f} =`}>
                {(id) => (
                  <input
                    id={id}
                    className="mono"
                    value={eqDraft[i] ?? ""}
                    placeholder={info.fields[f] ? typeOf(info.fields[f]) : "any value"}
                    onChange={(e) => setEqDraft((d) => Object.assign([...d], { [i]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
            {fields.length > 0 && (
              <div className="filter-actions">
                <Button type="submit">Apply</Button>
                {eq.length > 0 && (
                  <Button variant="ghost" onClick={clearFilter}>
                    Clear
                  </Button>
                )}
              </div>
            )}
            <div className="field push">
              <span className="label">Order</span>
              <Segmented
                label="Order"
                value={order}
                options={[
                  { value: "desc", label: "Newest" },
                  { value: "asc", label: "Oldest" },
                ]}
                onChange={(o) => {
                  setOrder(o);
                  reset();
                }}
              />
            </div>
          </form>
          <div className="table-body">
            <ErrorNote error={docs.error} />
            {docs.loading && !docs.data ? (
              <Skeleton rows={6} />
            ) : page.length ? (
              <div className="table-wrap docs-table">
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c} scope="col">
                          <span className="col-name">
                            {refs.has(c) && <Icon name="link" size={11} />}
                            {c}
                          </span>
                          <span className="col-type">{typeLabel(c)}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.map((d) => (
                      <tr key={d._id} tabIndex={0} className="clickable" onClick={() => setSelected(d)} onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && setSelected(d)}>
                        {columns.map((c) => (
                          <td key={c}>
                            {c === "_creationTime" ? (
                              <span className="muted nowrap small">{formatTime(d[c] as number)}</span>
                            ) : refs.has(c) ? (
                              <RefChips ids={idsOf(d[c])} docs={resolved} go={goTo} />
                            ) : (
                              <Code value={d[c]} />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="data">{eq.length ? "No documents match this filter." : "This table is empty."}</Empty>
            )}
          </div>
          <footer className="pager">
            <span className="muted small">
              {page.length ? `Page ${cursors.length} · ${plural(page.length, "document")}${eq.length ? " matching" : ""}` : `Page ${cursors.length}`}
            </span>
            <span className="push" />
            <Button variant="ghost" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
              ← Previous
            </Button>
            <Button variant="ghost" disabled={!docs.data || docs.data.isDone} onClick={() => docs.data && setCursors((c) => [...c, docs.data!.continueCursor])}>
              Next →
            </Button>
          </footer>
        </>
      )}
      {selected && (
        <DocDrawer
          table={table}
          doc={selected === "new" ? null : selected}
          admin={admin}
          manifest={manifest}
          go={goTo}
          onQuery={onQuery}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            docs.reload();
            onChange();
          }}
        />
      )}
    </section>
  );
}

/** The table's shape: one row per field, then its indexes. */
function SchemaView({ table, info, manifest, onOpenTable }: { table: string; info: TableInfo; manifest: Manifest; onOpenTable: (table: string) => void }) {
  const usedBy = (field: string) => [
    ...Object.entries(info.indexes)
      .filter(([, f]) => f.includes(field))
      .map(([i]) => i),
    ...Object.entries(info.searchIndexes ?? {})
      .filter(([, s]) => s.searchField === field || s.filterFields.includes(field))
      .map(([i]) => i),
    ...(field === "_creationTime" ? ["by_creation_time"] : []),
  ];
  const rows: {
    name: string;
    type: string;
    optional: boolean;
    system?: boolean;
  }[] = [
    { name: "_id", type: `Id<"${table}">`, optional: false, system: true },
    ...Object.entries(info.fields).map(([name, v]) => ({
      name,
      type: typeOf(v),
      optional: v.optional,
    })),
    { name: "_creationTime", type: "number", optional: false, system: true },
  ];
  return (
    <div className="stack">
      <section aria-label="Fields" className="stack schema-section">
        <div className="section-head">
          <h3>Fields</h3>
          <span className="muted small">{!info.strict ? "Managed by Better Auth." : "Every write is validated against these types."}</span>
        </div>
        <div className="table-wrap">
          <table className="schema-table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Type</th>
                <th scope="col">Required</th>
                <th scope="col">Used by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>
                    <code className="field-name">{r.name}</code>
                    {r.system && <span className="faint small"> system</span>}
                  </td>
                  <td>
                    <code className="type-code">{r.type}</code>
                  </td>
                  <td>{r.optional ? <Badge>optional</Badge> : <Badge tone="ok">required</Badge>}</td>
                  <td>
                    <span className="chips">
                      {usedBy(r.name).map((i) => (
                        <code key={i} className="id-chip">
                          {i}
                        </code>
                      ))}
                      {!usedBy(r.name).length && <span className="faint">—</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-label="Indexes" className="stack schema-section">
        <div className="section-head">
          <h3>Indexes</h3>
          <span className="muted small">Queries filter on index fields in order, left to right.</span>
        </div>
        <div className="table-wrap">
          <table className="schema-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Fields</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code className="field-name">by_creation_time</code>
                  <span className="faint small"> built in</span>
                </td>
                <td>
                  <Badge>index</Badge>
                </td>
                <td>
                  <span className="chips">
                    <code className="id-chip">_creationTime</code>
                  </span>
                </td>
              </tr>
              {Object.entries(info.indexes).map(([name, f]) => (
                <tr key={name}>
                  <td>
                    <code className="field-name">{name}</code>
                  </td>
                  <td>
                    <Badge>index</Badge>
                  </td>
                  <td>
                    <span className="chips">
                      {f.map((x, i) => (
                        <code key={x} className="id-chip">
                          <b>{i + 1}</b> {x}
                        </code>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
              {Object.entries(info.searchIndexes ?? {}).map(([name, s]) => (
                <tr key={name}>
                  <td>
                    <code className="field-name">{name}</code>
                  </td>
                  <td>
                    <Badge tone="accent">search</Badge>
                  </td>
                  <td>
                    <span className="chips">
                      <code className="id-chip">
                        <b>text</b> {s.searchField}
                      </code>
                      {s.filterFields.map((x) => (
                        <code key={x} className="id-chip">
                          <b>filter</b> {x}
                        </code>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <TableRelations table={table} manifest={manifest} onOpenTable={onOpenTable} />
    </div>
  );
}

function DocDrawer({
  table,
  doc,
  admin,
  manifest,
  go,
  onQuery,
  onClose,
  onSaved,
}: {
  table: string;
  doc: Doc | null;
  admin: Admin;
  manifest: Manifest;
  go: Go;
  onQuery?: (draft?: Draft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { _id, _creationTime, ...fields } = doc ?? ({} as Doc);
  const [draft, setDraft] = useState(JSON.stringify(doc ? fields : {}, null, 2));
  const { run, busy } = useAction();
  const editable = canWrite(admin);
  const value = () => JSON.parse(draft);
  return (
    <Drawer title={doc ? `${table} document` : `New ${table} document`} onClose={onClose}>
      {doc && (
        <dl className="meta">
          <dt>ID</dt>
          <dd className="mono">{doc._id}</dd>
          <dt>Created</dt>
          <dd>{formatTime(doc._creationTime)}</dd>
        </dl>
      )}
      {doc && <Relationships table={table} doc={doc} manifest={manifest} admin={admin} go={go} onQuery={onQuery} />}
      {editable ? (
        <>
          <Field
            label="Fields"
            hint={doc ? "Patch merges these into the document; Replace keeps only what's here. Validated against the schema." : "Validated against the schema, like any write."}
          >
            {(id) => <JsonEditor id={id} value={draft} onChange={setDraft} rows={16} />}
          </Field>
          <div className="toolbar">
            {doc ? (
              <>
                <Button disabled={busy} onClick={() => run(() => post("patchDoc", { id: doc._id, value: value() }), "Patched").then((r) => r.ok && onSaved())}>
                  Patch
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => run(() => post("replaceDoc", { id: doc._id, value: value() }), "Replaced").then((r) => r.ok && onSaved())}>
                  Replace
                </Button>
                <Button
                  variant="danger"
                  className="push"
                  disabled={busy}
                  onClick={() => confirm(`Delete ${doc._id}?`) && run(() => post("deleteDoc", { id: doc._id }), "Deleted").then((r) => r.ok && onSaved())}
                >
                  Delete
                </Button>
              </>
            ) : (
              <Button disabled={busy} onClick={() => run(() => post("insertDoc", { table, value: value() }), "Inserted").then((r) => r.ok && onSaved())}>
                Insert
              </Button>
            )}
          </div>
        </>
      ) : (
        <JsonView value={doc} />
      )}
    </Drawer>
  );
}
