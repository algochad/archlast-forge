import { useState } from "react";
import { canWrite, get, post, typeOf, type Admin, type Doc, type FunctionInfo, type Manifest, type Page, type Validator } from "../api";
import { Badge, Button, Empty, Field, JsonEditor, JsonView, useAction } from "../ui";

type Run = { time: number; args: unknown; asUser?: string; ok: boolean; value: unknown; ms: number };

const historyKey = (name: string) => `afx:history:${name}`;
const readHistory = (name: string): Run[] => {
  try {
    return JSON.parse(localStorage.getItem(historyKey(name)) ?? "[]");
  } catch {
    return [];
  }
};

const simple = (v: Validator) => ["string", "number", "boolean", "id", "null"].includes(v.kind);

export function Functions({ manifest, admin }: { manifest: Manifest; admin: Admin }) {
  const [filter, setFilter] = useState("");
  const [name, setName] = useState(manifest.functions[0]?.name ?? "");
  const shown = manifest.functions.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()));
  const fn = manifest.functions.find((f) => f.name === name);
  return (
    <div className="split">
      <nav className="panel list" aria-label="Functions">
        <input type="search" placeholder="Filter functions" aria-label="Filter functions" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {shown.map((f) => (
          <button key={f.name} aria-current={f.name === name} onClick={() => setName(f.name)}>
            <span>{f.name}</span>
            <span className="muted small">
              {f.kind[0]!.toUpperCase()}
              {f.visibility === "internal" ? " · internal" : ""}
            </span>
          </button>
        ))}
        {!shown.length && <Empty>No matches.</Empty>}
      </nav>
      {fn ? <Runner key={fn.name} fn={fn} admin={admin} /> : <Empty>Pick a function.</Empty>}
    </div>
  );
}

function Runner({ fn, admin }: { fn: FunctionInfo; admin: Admin }) {
  const formable = Object.values(fn.args).every(simple);
  const [mode, setMode] = useState<"form" | "json">(formable ? "form" : "json");
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [json, setJson] = useState("{}");
  const [asUser, setAsUser] = useState("");
  const [history, setHistory] = useState<Run[]>(() => readHistory(fn.name));
  const { run, busy } = useAction();

  const buildArgs = () => {
    if (mode === "json") return JSON.parse(json || "{}");
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fn.args)) {
      const raw = form[k];
      if (v.kind === "boolean") args[k] = Boolean(raw);
      else if (v.kind === "null") args[k] = null;
      else if (raw === undefined || raw === "") {
        if (!v.optional) args[k] = v.kind === "number" ? NaN : ""; // let the server report the missing value
      } else args[k] = v.kind === "number" ? Number(raw) : raw;
    }
    return args;
  };

  async function execute() {
    let userId: string | undefined;
    if (asUser.trim()) {
      const q = asUser.trim();
      userId = q.startsWith("users:") ? q : (await get<Page<Doc>>("users", { email: q, numItems: 1 }).catch(() => null))?.page[0]?._id;
      if (!userId) throw new Error(`No user with email ${q}`);
    }
    const args = buildArgs();
    const started = performance.now();
    let entry: Run;
    try {
      const value = await post("run", { name: fn.name, kind: fn.kind, args, asUserId: userId });
      entry = { time: Date.now(), args, asUser: asUser || undefined, ok: true, value, ms: Math.round(performance.now() - started) };
    } catch (e) {
      entry = { time: Date.now(), args, asUser: asUser || undefined, ok: false, value: (e as Error).message, ms: Math.round(performance.now() - started) };
    }
    const next = [entry, ...history].slice(0, 10);
    setHistory(next);
    localStorage.setItem(historyKey(fn.name), JSON.stringify(next));
    if (!entry.ok) throw new Error(String(entry.value));
  }

  return (
    <section className="panel stack" aria-label={fn.name}>
      <div className="toolbar">
        <h2>{fn.name}</h2>
        <Badge tone="accent">{fn.kind}</Badge>
        {fn.visibility === "internal" && <Badge tone="warn">internal</Badge>}
      </div>
      <p className="muted small">
        args <code>{`{ ${Object.entries(fn.args).map(([k, v]) => `${k}${v.optional ? "?" : ""}: ${typeOf(v)}`).join("; ")} }`}</code>
        {fn.returns && (
          <>
            {" "}
            → <code>{typeOf(fn.returns)}</code>
          </>
        )}
      </p>
      {!canWrite(admin) ? (
        <p className="note">Running functions needs the admin role.</p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(execute);
          }}
        >
          {formable && (
            <div className="toolbar" role="radiogroup" aria-label="Arguments as">
              <Button variant={mode === "form" ? "primary" : "ghost"} onClick={() => setMode("form")} aria-pressed={mode === "form"}>
                Form
              </Button>
              <Button
                variant={mode === "json" ? "primary" : "ghost"}
                onClick={() => {
                  setJson(JSON.stringify(buildArgs(), null, 2));
                  setMode("json");
                }}
                aria-pressed={mode === "json"}
              >
                JSON
              </Button>
            </div>
          )}
          {mode === "form" ? (
            Object.keys(fn.args).length ? (
              <div className="grid-form">
                {Object.entries(fn.args).map(([k, v]) => (
                  <Field key={k} label={`${k}${v.optional ? " (optional)" : ""}`} hint={typeOf(v)}>
                    {(id) =>
                      v.kind === "boolean" ? (
                        <input id={id} type="checkbox" checked={Boolean(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
                      ) : v.kind === "null" ? (
                        <input id={id} disabled value="null" />
                      ) : (
                        <input
                          id={id}
                          type={v.kind === "number" ? "number" : "text"}
                          step="any"
                          placeholder={v.kind === "id" ? `${v.table}:…` : ""}
                          value={String(form[k] ?? "")}
                          onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                        />
                      )
                    }
                  </Field>
                ))}
              </div>
            ) : (
              <p className="muted">No arguments.</p>
            )
          ) : (
            <Field label="Arguments (JSON)">{(id) => <JsonEditor id={id} value={json} onChange={setJson} rows={8} />}</Field>
          )}
          <Field label="Run as user" hint="Email or users:… id. Empty runs without a signed-in user.">
            {(id) => <input id={id} value={asUser} placeholder="anonymous" onChange={(e) => setAsUser(e.target.value)} />}
          </Field>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? "Running…" : `Run ${fn.kind}`}
            </Button>
          </div>
        </form>
      )}
      {history.length > 0 && (
        <div className="stack">
          <div className="toolbar">
            <h3>Recent runs</h3>
            <Button
              variant="ghost"
              className="push"
              onClick={() => {
                localStorage.removeItem(historyKey(fn.name));
                setHistory([]);
              }}
            >
              Clear
            </Button>
          </div>
          {history.map((h, i) => (
            <details key={h.time} open={i === 0} className="run">
              <summary>
                <Badge tone={h.ok ? "ok" : "bad"}>{h.ok ? "ok" : "failed"}</Badge> {new Date(h.time).toLocaleTimeString()} · {h.ms} ms
                {h.asUser && <span className="muted"> · as {h.asUser}</span>}
              </summary>
              <p className="muted small">args</p>
              <JsonView value={h.args} />
              <p className="muted small">{h.ok ? "result" : "error"}</p>
              <JsonView value={h.value} />
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
