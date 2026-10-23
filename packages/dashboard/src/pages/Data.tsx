import { useEffect, useState } from "react";
import { canWrite, fieldsOf, formatTime, get, post, type Admin, type Doc, type Manifest, type Page } from "../api";
import { Badge, Button, Code, Drawer, Empty, ErrorNote, Field, JsonEditor, JsonView, Skeleton, useAction, useAsync } from "../ui";

/** A filter value: JSON when it parses (numbers, booleans), otherwise the text itself. */
const parseValue = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export function Data({ manifest, admin }: { manifest: Manifest; admin: Admin }) {
  const tables = Object.keys(manifest.tables);
  const [table, setTable] = useState(() => localStorage.getItem("afx:table") ?? tables[0] ?? "");
  const counts = useAsync(() => get<Record<string, number>>("counts", { tables }), [tables.join()], { interval: 10_000 });
  useEffect(() => localStorage.setItem("afx:table", table), [table]);
  if (!tables.length) return <Empty icon="data">No tables yet. Define them in convex/schema.ts.</Empty>;
  return (
    <div className="split">
      <nav className="panel list" aria-label="Tables">
        {tables.map((t) => (
          <button key={t} aria-current={t === table} onClick={() => setTable(t)}>
            <span>{t}</span>
            <span className="muted">{counts.data?.[t] ?? ""}</span>
          </button>
        ))}
      </nav>
      {manifest.tables[table] ? <TableView key={table} table={table} manifest={manifest} admin={admin} onChange={counts.reload} /> : <Empty icon="data">Pick a table.</Empty>}
    </div>
  );
}

function TableView({ table, manifest, admin, onChange }: { table: string; manifest: Manifest; admin: Admin; onChange: () => void }) {
  const info = manifest.tables[table]!;
  const indexes = ["by_creation_time", ...Object.keys(info.indexes)];
  const [index, setIndex] = useState("by_creation_time");
  const [eqDraft, setEqDraft] = useState<string[]>([]);
  const [eq, setEq] = useState<[string, unknown][]>([]);
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Doc | "new" | null>(null);
  const fields = index === "by_creation_time" ? [] : info.indexes[index]!;
  const cursor = cursors.at(-1) ?? null;
  const docs = useAsync(
    () => get<Page>("docs", { table, index: index === "by_creation_time" ? undefined : index, eq, order, cursor, numItems: 50 }),
    [table, index, JSON.stringify(eq), order, cursor],
    { interval: 4000 },
  );
  const columns = [...new Set((docs.data?.page ?? []).flatMap((d) => Object.keys(d)))];
  const reset = () => setCursors([null]);

  return (
    <section className="panel stack" aria-label={`${table} documents`}>
      <div className="toolbar">
        <h2>{table}</h2>
        {!info.strict && <Badge tone="accent">Better Auth</Badge>}
        <code className="muted small">{fieldsOf(info.fields)}</code>
        {canWrite(admin) && (
          <Button onClick={() => setSelected("new")} className="push">
            Add document
          </Button>
        )}
      </div>
      <form
        className="toolbar"
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
                setEqDraft([]);
                setEq([]);
                reset();
              }}
            >
              {indexes.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          )}
        </Field>
        {fields.map((f, i) => (
          <Field key={f} label={`${f} =`}>
            {(id) => (
              <input id={id} value={eqDraft[i] ?? ""} placeholder="any" onChange={(e) => setEqDraft((d) => Object.assign([...d], { [i]: e.target.value }))} />
            )}
          </Field>
        ))}
        {fields.length > 0 && <Button type="submit">Filter</Button>}
        <Field label="Order">
          {(id) => (
            <select
              id={id}
              value={order}
              onChange={(e) => {
                setOrder(e.target.value as "asc" | "desc");
                reset();
              }}
            >
              <option value="desc">newest first</option>
              <option value="asc">oldest first</option>
            </select>
          )}
        </Field>
      </form>
      <ErrorNote error={docs.error} />
      {docs.loading && !docs.data ? (
        <Skeleton rows={5} />
      ) : docs.data?.page.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.data.page.map((d) => (
                <tr key={d._id} tabIndex={0} className="clickable" onClick={() => setSelected(d)} onKeyDown={(e) => e.key === "Enter" && setSelected(d)}>
                  {columns.map((c) => (
                    <td key={c}>{c === "_creationTime" ? <span className="muted">{formatTime(d[c] as number)}</span> : <Code value={d[c]} />}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="data">No documents{eq.length ? " match this filter" : ""}.</Empty>
      )}
      <div className="toolbar">
        <Button variant="ghost" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
          ← Previous
        </Button>
        <span className="muted small">Page {cursors.length}</span>
        <Button variant="ghost" disabled={!docs.data || docs.data.isDone} onClick={() => docs.data && setCursors((c) => [...c, docs.data!.continueCursor])}>
          Next →
        </Button>
      </div>
      {selected && (
        <DocDrawer
          table={table}
          doc={selected === "new" ? null : selected}
          admin={admin}
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

function DocDrawer({ table, doc, admin, onClose, onSaved }: { table: string; doc: Doc | null; admin: Admin; onClose: () => void; onSaved: () => void }) {
  const { _id, _creationTime, ...fields } = doc ?? ({} as Doc);
  const [draft, setDraft] = useState(JSON.stringify(doc ? fields : {}, null, 2));
  const { run, busy } = useAction();
  const editable = canWrite(admin);
  const value = () => JSON.parse(draft);
  return (
    <Drawer title={doc ? doc._id : `New ${table} document`} onClose={onClose}>
      {doc && (
        <p className="muted small">
          Created {formatTime(doc._creationTime)} · <span className="mono">{doc._id}</span>
        </p>
      )}
      {editable ? (
        <>
          <Field label={doc ? "Fields (replace keeps only what's here; patch merges)" : "Fields"} hint="Validated against the schema, like any write.">
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
