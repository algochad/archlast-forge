import { StrictMode, useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

type Kind = "query" | "mutation" | "action";
type Validator = { kind: string; optional: boolean; table?: string; element?: Validator; fields?: Record<string, Validator>; members?: Validator[] };
type Manifest = {
  functions: { name: string; kind: Kind; args: Record<string, Validator>; returns?: Validator }[];
  tables: Record<string, { fields: Record<string, Validator>; indexes: Record<string, string[]>; strict: boolean }>;
  crons: { name: string; fn: string; schedule: { kind: string; ms?: number; expression?: string } }[];
  storage: boolean;
  error?: string;
};
type Log = { time: number; name: string; level: string; message: string; durationMs?: number; ok?: boolean };

const KEY = "archlast-forge:admin-key";

/** Calls the admin tRPC router over plain HTTP. */
async function admin<T>(key: string, path: string, input?: unknown, mutation = false): Promise<T> {
  const url = `/_admin/${path}${!mutation && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`;
  const res = await fetch(url, {
    method: mutation ? "POST" : "GET",
    headers: { "x-admin-key": key, "content-type": "application/json" },
    body: mutation ? JSON.stringify(input) : undefined,
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result.data as T;
}

function usePoll<T>(fn: () => Promise<T>, ms: number | null, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const load = useCallback(() => fn().then((data) => setState({ data }), (e: Error) => setState({ error: e.message })), deps);
  useEffect(() => {
    load();
    if (ms === null) return;
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [load, ms]);
  return { ...state, reload: load };
}

const typeOf = (v: Validator): string =>
  v.kind === "id"
    ? `Id<"${v.table}">`
    : v.kind === "array"
      ? `${typeOf(v.element!)}[]`
      : v.kind === "object"
        ? `{ ${fieldsOf(v.fields!)} }`
        : v.kind === "union"
          ? v.members!.map(typeOf).join(" | ")
          : v.kind;
const fieldsOf = (fields: Record<string, Validator>) =>
  Object.entries(fields).map(([k, v]) => `${k}${v.optional ? "?" : ""}: ${typeOf(v)}`).join("; ");

const TABS = ["Data", "Functions", "Logs", "Schema", "Subscriptions", "Scheduled"] as const;

function App() {
  const [key, setKey] = useState(() => sessionStorage.getItem(KEY) ?? "");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Data");
  const manifest = usePoll(() => (key ? admin<Manifest>(key, "manifest") : Promise.reject(new Error("Enter the admin key"))), key ? 5000 : null, [key]);

  if (!key || manifest.error?.match(/admin key|ADMIN_KEY/)) return <Login error={key ? manifest.error : undefined} onKey={(k) => (sessionStorage.setItem(KEY, k), setKey(k))} />;
  const m = manifest.data;
  return (
    <>
      <header>
        <strong>archlast-forge</strong>
        <nav>
          {TABS.map((t) => (
            <button key={t} aria-current={t === tab ? "page" : undefined} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <button style={{ marginLeft: "auto", background: "none", color: "var(--muted)" }} onClick={() => (sessionStorage.removeItem(KEY), setKey(""))}>
          Lock
        </button>
      </header>
      <main>
        {m?.error && <p className="panel bad">Function runtime failed to load: {m.error}</p>}
        {!m ? (
          <p className="muted">{manifest.error ?? "Loading…"}</p>
        ) : tab === "Data" ? (
          <Data adminKey={key} manifest={m} />
        ) : tab === "Functions" ? (
          <Functions adminKey={key} manifest={m} />
        ) : tab === "Logs" ? (
          <Logs adminKey={key} />
        ) : tab === "Schema" ? (
          <Schema manifest={m} />
        ) : tab === "Subscriptions" ? (
          <Subscriptions adminKey={key} />
        ) : (
          <Scheduled adminKey={key} manifest={m} />
        )}
      </main>
    </>
  );
}

function Login({ onKey, error }: { onKey(k: string): void; error?: string }) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onKey(String(new FormData(e.currentTarget).get("key")));
  };
  return (
    <form className="login panel" onSubmit={submit}>
      <strong>archlast-forge dashboard</strong>
      <input name="key" type="password" placeholder="ADMIN_KEY" aria-label="Admin key" required autoFocus />
      <button>Open</button>
      {error && <p className="bad">{error}</p>}
      <p className="muted">`archlast-forge dev` prints the key on startup.</p>
    </form>
  );
}

function Data({ adminKey, manifest }: { adminKey: string; manifest: Manifest }) {
  const tables = Object.keys(manifest.tables);
  const [table, setTable] = useState(tables[0] ?? "");
  const docs = usePoll(() => admin<Record<string, unknown>[]>(adminKey, "docs", { table, limit: 100 }), 2000, [adminKey, table]);
  const columns = [...new Set((docs.data ?? []).flatMap((d) => Object.keys(d)))];
  return (
    <div className="split">
      <ul className="list panel">
        {tables.map((t) => (
          <li key={t}>
            <button aria-current={t === table} onClick={() => setTable(t)}>{t}</button>
          </li>
        ))}
      </ul>
      <div className="panel">
        <p className="muted">{table}: newest 100 documents, refreshed every 2 s</p>
        {docs.error && <p className="bad">{docs.error}</p>}
        <table>
          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {docs.data?.map((d) => (
              <tr key={String(d._id)}>
                {columns.map((c) => <td key={c}><code>{c === "_creationTime" ? new Date(d[c] as number).toLocaleString() : JSON.stringify(d[c])}</code></td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {docs.data?.length === 0 && <p className="muted">No documents.</p>}
      </div>
    </div>
  );
}

function Functions({ adminKey, manifest }: { adminKey: string; manifest: Manifest }) {
  const [name, setName] = useState(manifest.functions[0]?.name ?? "");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const fn = manifest.functions.find((f) => f.name === name);
  async function run() {
    try {
      const value = await admin(adminKey, "run", { name, kind: fn!.kind, args: JSON.parse(args) }, true);
      setResult({ ok: true, text: JSON.stringify(value, null, 2) });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    }
  }
  return (
    <div className="split">
      <ul className="list panel">
        {manifest.functions.map((f) => (
          <li key={f.name}>
            <button aria-current={f.name === name} onClick={() => (setName(f.name), setResult(undefined))}>
              <span className="muted">{f.kind[0]!.toUpperCase()}</span> {f.name}
            </button>
          </li>
        ))}
      </ul>
      {fn && (
        <div className="panel" style={{ display: "grid", gap: "0.6rem", alignContent: "start" }}>
          <div><strong>{fn.name}</strong> <span className="muted">({fn.kind}, runs without a user identity)</span></div>
          <code>args: {`{ ${fieldsOf(fn.args)} }`}</code>
          {fn.returns && <code>returns: {typeOf(fn.returns)}</code>}
          <textarea value={args} onChange={(e) => setArgs(e.target.value)} aria-label="Arguments as JSON" />
          <div><button onClick={run}>Run</button></div>
          {result && <pre className={result.ok ? "" : "bad"}>{result.text}</pre>}
        </div>
      )}
    </div>
  );
}

function Logs({ adminKey }: { adminKey: string }) {
  const logs = usePoll(() => admin<Log[]>(adminKey, "logs"), 2000, [adminKey]);
  const calls = (logs.data ?? []).filter((l) => l.level === "call");
  const stats = Object.entries(
    calls.reduce<Record<string, { n: number; errors: number; ms: number }>>((acc, l) => {
      const s = (acc[l.name] ??= { n: 0, errors: 0, ms: 0 });
      s.n++;
      if (!l.ok) s.errors++;
      s.ms += l.durationMs ?? 0;
      return acc;
    }, {}),
  ).sort((a, b) => b[1].n - a[1].n);
  return (
    <>
      <div className="panel">
        <p className="muted">Metrics over the last {calls.length} calls on this server</p>
        <table>
          <thead><tr><th>function</th><th className="num">calls</th><th className="num">errors</th><th className="num">avg ms</th></tr></thead>
          <tbody>
            {stats.map(([name, s]) => (
              <tr key={name}><td>{name}</td><td className="num">{s.n}</td><td className={`num ${s.errors ? "bad" : ""}`}>{s.errors}</td><td className="num">{(s.ms / s.n).toFixed(1)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>time</th><th>function</th><th>level</th><th>message</th></tr></thead>
          <tbody>
            {[...(logs.data ?? [])].reverse().slice(0, 300).map((l, i) => (
              <tr key={i}>
                <td className="muted">{new Date(l.time).toLocaleTimeString()}</td>
                <td>{l.name}</td>
                <td className={l.level === "call" ? (l.ok ? "ok" : "bad") : l.level === "error" ? "bad" : ""}>{l.level === "call" ? `${l.ok ? "ok" : "failed"} ${l.durationMs}ms` : l.level}</td>
                <td><code>{l.message}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Schema({ manifest }: { manifest: Manifest }) {
  return (
    <div className="panel">
      <table>
        <thead><tr><th>table</th><th>fields</th><th>indexes</th></tr></thead>
        <tbody>
          {Object.entries(manifest.tables).map(([name, t]) => (
            <tr key={name}>
              <td>{name}{!t.strict && <span className="muted"> (Better Auth)</span>}</td>
              <td><code>{fieldsOf(t.fields)}</code></td>
              <td>{Object.entries(t.indexes).map(([i, f]) => <div key={i}><code>{i}: [{f.join(", ")}]</code></div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Storage: {manifest.storage ? "configured" : "not configured"}</p>
    </div>
  );
}

function Subscriptions({ adminKey }: { adminKey: string }) {
  const subs = usePoll(() => admin<{ name: string; args: unknown; topics: string[]; since: number }[]>(adminKey, "subscriptions"), 2000, [adminKey]);
  return (
    <div className="panel">
      <p className="muted">{subs.data?.length ?? 0} active subscriptions on this server</p>
      <table>
        <thead><tr><th>query</th><th>args</th><th>topics</th><th>since</th></tr></thead>
        <tbody>
          {subs.data?.map((s, i) => (
            <tr key={i}>
              <td>{s.name}</td>
              <td><code>{JSON.stringify(s.args)}</code></td>
              <td>{s.topics.map((t) => <div key={t}><code>{t}</code></div>)}</td>
              <td className="muted">{new Date(s.since).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Scheduled({ adminKey, manifest }: { adminKey: string; manifest: Manifest }) {
  type Job = { _id: string; name: string; args: string; scheduledTime: number; state: string; error: string | null };
  const jobs = usePoll(() => admin<Job[]>(adminKey, "scheduled"), 2000, [adminKey]);
  return (
    <>
      <div className="panel">
        <strong>Crons</strong>
        <table>
          <tbody>
            {manifest.crons.map((c) => (
              <tr key={c.name}><td>{c.name}</td><td><code>{c.fn}</code></td><td className="muted">{c.schedule.kind === "interval" ? `every ${c.schedule.ms! / 1000}s` : `${c.schedule.expression} (UTC)`}</td></tr>
            ))}
          </tbody>
        </table>
        {manifest.crons.length === 0 && <p className="muted">No crons.ts.</p>}
      </div>
      <div className="panel">
        <table>
          <thead><tr><th>scheduled for</th><th>function</th><th>args</th><th>state</th></tr></thead>
          <tbody>
            {jobs.data?.map((j) => (
              <tr key={j._id}>
                <td className="muted">{new Date(j.scheduledTime).toLocaleString()}</td>
                <td>{j.name}</td>
                <td><code>{j.args}</code></td>
                <td className={j.state === "failed" ? "bad" : j.state === "success" ? "ok" : ""}>{j.state}{j.error && `: ${j.error}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.data?.length === 0 && <p className="muted">No scheduled jobs yet.</p>}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
