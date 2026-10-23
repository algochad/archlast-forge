import { useEffect, useState } from "react";
import { CodeEditor } from "../code-editor";
import { get, post, type Admin, type Doc, type Manifest, type Page, type TableInfo, type Validator } from "../api";
import { Icon } from "../brand";
import { indexFor, refsOf } from "../relations";
import { RefChips } from "./Refs";
import { Badge, Button, Code, Empty, Field, JsonEditor, JsonView, KindPill, Segmented, Skeleton, useAction, useAsync, useToast } from "../ui";

export type Draft = { code: string; args: string };
type Log = { time: number; level: string; message: string };
type Result = { ok: boolean; kind?: "query" | "mutation"; value?: unknown; error?: string; line?: number; phase?: "compile" | "run"; ms: number; logs: Log[] };

const validatorSource = (v: Validator) => (v.kind === "id" ? `v.id("${v.table}")` : ["string", "number", "boolean"].includes(v.kind) ? `v.${v.kind}()` : "v.string()");
const sample = (v: Validator) => (v.kind === "number" ? 0 : v.kind === "boolean" ? false : "");

/** A starting point for a table: the first thing most people want is to see its documents. */
export const readTable = (table: string): Draft => ({
  code: `export default query({
  handler: async (ctx) => {
    return await ctx.db.query("${table}").order("desc").take(50);
  },
});
`,
  args: "{}",
});

export function examples(manifest: Manifest): { label: string; draft: Draft }[] {
  const mine = Object.entries(manifest.tables).filter(([name, t]) => t.strict && !name.startsWith("_"));
  const [table, info] = (mine[0] ?? ["todos", undefined]) as [string, TableInfo | undefined];
  const index = info && Object.entries(info.indexes)[0];
  return [
    { label: "Read a table", draft: readTable(table) },
    {
      label: "Count documents",
      draft: {
        code: `export default query({
  handler: async (ctx) => {
    const docs = await ctx.db.query("${table}").collect();
    return { count: docs.length };
  },
});
`,
        args: "{}",
      },
    },
    ...(index && info
      ? [
          {
            label: "Filter with an index",
            draft: {
              code: `export default query({
  args: { ${index[1][0]}: ${validatorSource(info.fields[index[1][0]!]!)} },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("${table}")
      .withIndex("${index[0]}", (q) => q.eq("${index[1][0]}", args.${index[1][0]}))
      .collect();
  },
});
`,
              args: JSON.stringify({ [index[1][0]!]: sample(info.fields[index[1][0]!]!) }),
            },
          },
        ]
      : []),
    ...joinExamples(manifest),
    {
      label: "Update documents (mutation)",
      draft: {
        code: `// A mutation commits when it returns, and rolls back if it throws.
export default mutation({
  handler: async (ctx) => {
    const docs = await ctx.db.query("${table}").take(10);
    for (const doc of docs) {
      await ctx.db.patch(doc._id, {
        // fields to change
      });
    }
    return docs.length;
  },
});
`,
        args: "{}",
      },
    },
    {
      label: "Log while it runs",
      draft: {
        code: `export default query({
  handler: async (ctx) => {
    const docs = await ctx.db.query("${table}").take(5);
    console.log("found", docs.length, "documents");
    return docs.map((d) => d._id);
  },
});
`,
        args: "{}",
      },
    },
  ];
}

/** Examples built from the schema's own references, so they run as they are. */
function joinExamples(manifest: Manifest): { label: string; draft: Draft }[] {
  const mine = Object.entries(manifest.tables).filter(([name, t]) => t.strict && !name.startsWith("_"));
  const found = mine.flatMap(([table, info]) => refsOf(info).filter((r) => !r.many && manifest.tables[r.target]?.strict).map((r) => ({ table, ref: r })))[0];
  if (!found) return [];
  const { table, ref } = found;
  const name = ref.field.endsWith("Id") && ref.field.length > 2 ? ref.field.slice(0, -2) : `${ref.field}Doc`;
  const index = indexFor(manifest.tables[table]!, ref.field);
  return [
    {
      label: "Join tables",
      draft: {
        code: `// include() adds the document each reference points at, loaded in one batch.
export default query({
  handler: async (ctx) => {
    return await ctx.db
      .query("${table}")
      .include({ ${name}: "${ref.field}" })
      .take(20);
  },
});
`,
        args: "{}",
      },
    },
    ...(index
      ? [
          {
            label: "Join the other way",
            draft: {
              code: `// Look the other direction: for each ${ref.target}, the ${table} that point back at it (through the "${index}" index).
export default query({
  handler: async (ctx) => {
    return await ctx.db
      .query("${ref.target}")
      .include({
        ${table}: { table: "${table}", index: "${index}", take: 5 },
        ${table}Count: { table: "${table}", index: "${index}", count: true },
      })
      .take(10);
  },
});
`,
              args: "{}",
            },
          },
        ]
      : []),
    {
      label: "Filter on joined data",
      draft: {
        code: `// A filter sees whatever include() added before it.
export default query({
  handler: async (ctx) => {
    return await ctx.db
      .query("${table}")
      .include({ ${name}: "${ref.field}" })
      .filter((doc) => doc.${name} !== null)
      .take(20);
  },
});
`,
        args: "{}",
      },
    },
  ];
}

const STORE = "afx:custom";
const load = (): Draft | undefined => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
};

export function CustomFunction({ manifest, admin, initial }: { manifest: Manifest; admin: Admin; initial?: Draft }) {
  const server = useAsync(() => get<{ customFunctions: boolean }>("server"), []);
  const samples = examples(manifest);
  const [draft, setDraft] = useState<Draft>(() => initial ?? load() ?? samples[0]!.draft);
  const [asUser, setAsUser] = useState("");
  const [result, setResult] = useState<Result>();
  const { run, busy } = useAction();
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(draft));
    } catch {
      /* private mode: the draft just isn't kept */
    }
  }, [draft]);

  if (server.loading && !server.data) return <Skeleton rows={6} />;
  if (admin.role !== "owner")
    return <Empty icon="key">Running your own code needs the owner role. It runs with the same access as your functions, so it can read and change anything in this deployment.</Empty>;
  if (!server.data?.customFunctions)
    return (
      <Empty icon="key">
        Custom functions are turned off on this server. Set <code>ALLOW_CUSTOM_FUNCTIONS=on</code> to let owners run code from the dashboard (it is on in development).
      </Empty>
    );

  async function execute() {
    let args: unknown;
    try {
      args = JSON.parse(draft.args || "{}");
    } catch {
      throw new Error("Arguments must be valid JSON");
    }
    let asUserId: string | undefined;
    if (asUser.trim()) {
      const q = asUser.trim();
      asUserId = q.startsWith("users:") ? q : (await get<Page<Doc>>("users", { email: q, numItems: 1 }).catch(() => null))?.page[0]?._id;
      if (!asUserId) throw new Error(`No user with email ${q}`);
    }
    setResult(await post<Result>("runCustom", { code: draft.code, args, asUserId }));
  }
  const go = () => !busy && void run(execute);

  return (
    <section className="panel stack custom" aria-label="Run a function">
      <header className="table-head custom-head">
        <span className="table-icon">
          <Icon name="functions" size={20} />
        </span>
        <div className="table-title">
          <h2>Run a function</h2>
          <p className="muted small">Write a query or a mutation and run it against this deployment.</p>
        </div>
        <span className="push" />
        <Field label="Examples">
          {(id) => (
            <select
              id={id}
              value=""
              onChange={(e) => {
                const s = samples.find((x) => x.label === e.target.value);
                if (s) setDraft(s.draft);
              }}
            >
              <option value="" disabled>
                Insert an example…
              </option>
              {samples.map((s) => (
                <option key={s.label}>{s.label}</option>
              ))}
            </select>
          )}
        </Field>
      </header>

      <div className="table-body">
        <Field label="Function" hint="TypeScript. query, mutation and v are in scope, so no imports are needed. Cmd or Ctrl and Enter runs it.">
          {(id) => <CodeEditor id={id} value={draft.code} onChange={(code) => setDraft({ ...draft, code })} onRun={go} />}
        </Field>
        <div className="custom-options">
          <Field label="Arguments (JSON)">{(id) => <JsonEditor id={id} value={draft.args} onChange={(args) => setDraft({ ...draft, args })} rows={3} />}</Field>
          <Field label="Run as user" hint="An email or users:… id. Empty runs without a signed-in user.">
            {(id) => <input id={id} value={asUser} placeholder="anonymous" onChange={(e) => setAsUser(e.target.value)} />}
          </Field>
        </div>
        <div className="toolbar">
          <Button onClick={go} disabled={busy}>
            <Icon name="bolt" size={16} /> {busy ? "Running…" : "Run"}
          </Button>
          <span className="muted small">A mutation changes real data. Every run is recorded in the audit log.</span>
        </div>
      </div>

      {result && <ResultPanel result={result} />}
    </section>
  );
}

/** A document, or a list of them, as a query that used include() returns them. */
const asDocs = (v: unknown): Doc[] | undefined => {
  const isDoc = (x: unknown): x is Doc => Boolean(x) && typeof x === "object" && typeof (x as Doc)._id === "string" && typeof (x as Doc)._creationTime === "number";
  return isDoc(v) ? [v] : Array.isArray(v) && v.length > 0 && v.every(isDoc) ? v : undefined;
};

const isRows = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x));
const MAX_ROWS = 200;

function ResultPanel({ result }: { result: Result }) {
  const toast = useToast();
  const tabular = result.ok && isRows(result.value);
  const [view, setView] = useState<"table" | "json">("table");
  const rows = tabular ? (result.value as Record<string, unknown>[]) : [];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <section className="result" aria-label="Result" aria-live="polite">
      <header className="result-head">
        <Badge tone={result.ok ? "ok" : "bad"}>{result.ok ? "Success" : "Failed"}</Badge>
        {result.kind && <KindPill kind={result.kind} />}
        <span className="muted small">
          {result.ms} ms
          {Array.isArray(result.value) && ` · ${result.value.length.toLocaleString()} ${result.value.length === 1 ? "item" : "items"}`}
        </span>
        <span className="push" />
        {tabular && (
          <Segmented
            label="Result view"
            value={view}
            options={[
              { value: "table", label: "Table" },
              { value: "json", label: "JSON" },
            ]}
            onChange={setView}
          />
        )}
        {result.ok && (
          <Button
            variant="ghost"
            onClick={() =>
              navigator.clipboard.writeText(JSON.stringify(result.value ?? null, null, 2)).then(
                () => toast("Copied"),
                () => toast("Couldn't copy", "error"),
              )
            }
          >
            Copy JSON
          </Button>
        )}
      </header>
      {result.error && (
        <pre className="run-error" role="alert">
          {result.line ? `Line ${result.line}: ` : ""}
          {result.error}
        </pre>
      )}
      {result.ok && tabular && view === "table" ? (
        <div className="table-wrap docs-table">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    <span className="col-name">{c}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}>
                      {c === "_creationTime" && typeof r[c] === "number" ? (
                        <span className="muted nowrap small">{new Date(r[c] as number).toLocaleString()}</span>
                      ) : asDocs(r[c]) ? (
                        <RefChips ids={asDocs(r[c])!.map((d) => d._id)} docs={Object.fromEntries(asDocs(r[c])!.map((d) => [d._id, d]))} />
                      ) : (
                        <Code value={r[c]} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && (
            <p className="muted small more-rows">
              Showing the first {MAX_ROWS} of {rows.length.toLocaleString()}. Switch to JSON or take fewer in the query.
            </p>
          )}
        </div>
      ) : (
        result.ok && <JsonView value={result.value ?? null} />
      )}
      {result.logs.length > 0 && (
        <div className="run-logs">
          <h3>Console</h3>
          {result.logs.map((l, i) => (
            <div key={i} className={`run-log ${l.level}`}>
              <span className="muted small">{new Date(l.time).toLocaleTimeString()}</span>
              <Badge tone={l.level === "error" ? "bad" : l.level === "warn" ? "warn" : "neutral"}>{l.level}</Badge>
              <code>{l.message}</code>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
