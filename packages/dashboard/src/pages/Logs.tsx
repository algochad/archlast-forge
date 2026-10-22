import { useEffect, useState } from "react";
import { get, type Log, type Manifest } from "../api";
import { Badge, Button, Empty, ErrorNote, Field, Spinner, useAsync } from "../ui";

const RANGES = { "15m": 15 * 60_000, "1h": 3600_000, "24h": 86400_000, "7d": 7 * 86400_000 } as const;

function LevelBadge({ log }: { log: Log }) {
  if (log.level === "call") return <Badge tone={log.ok ? "ok" : "bad"}>{log.ok ? "ok" : "failed"}</Badge>;
  return <Badge tone={log.level === "error" ? "bad" : log.level === "warn" ? "warn" : "neutral"}>{log.level}</Badge>;
}

function LogTable({ logs, onRequest }: { logs: Log[]; onRequest: (id: string) => void }) {
  if (!logs.length) return <Empty>No log entries.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">time</th>
            <th scope="col">function</th>
            <th scope="col">level</th>
            <th scope="col">message</th>
            <th scope="col" className="num">
              ms
            </th>
            <th scope="col">request</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l, i) => (
            <tr key={i}>
              <td className="muted nowrap">{new Date(l.time).toLocaleTimeString()}</td>
              <td className="nowrap">{l.name}</td>
              <td>
                <LevelBadge log={l} />
              </td>
              <td>
                <code className="cell-code">{l.level === "call" && l.ok ? "" : l.message}</code>
              </td>
              <td className="num">{l.durationMs ?? ""}</td>
              <td>
                {l.requestId && (
                  <button className="link mono small" onClick={() => onRequest(l.requestId!)} title="Show everything from this request">
                    {l.requestId.slice(0, 8)}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Logs({ manifest }: { manifest: Manifest }) {
  const [mode, setMode] = useState<"live" | "history">("live");
  const [filters, setFilters] = useState({ name: "", level: "", range: "1h" as keyof typeof RANGES, requestId: "" });
  return (
    <section className="panel stack" aria-label="Logs">
      <div className="toolbar" role="radiogroup" aria-label="Source">
        <Button variant={mode === "live" ? "primary" : "ghost"} aria-pressed={mode === "live"} onClick={() => setMode("live")}>
          Live (this server)
        </Button>
        <Button variant={mode === "history" ? "primary" : "ghost"} aria-pressed={mode === "history"} onClick={() => setMode("history")}>
          History (all servers)
        </Button>
      </div>
      {mode === "live" ? (
        <Live onRequest={(id) => (setFilters({ ...filters, requestId: id }), setMode("history"))} />
      ) : (
        <History manifest={manifest} filters={filters} setFilters={setFilters} />
      )}
    </section>
  );
}

function Live({ onRequest }: { onRequest: (id: string) => void }) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    get<Log[]>("recentLogs").then((l) => setLogs(l.slice(-200).reverse()), () => {});
    const es = new EventSource("/_admin/logs/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => !paused && setLogs((l) => [JSON.parse(e.data) as Log, ...l].slice(0, 500));
    return () => es.close();
  }, [paused]);
  return (
    <>
      <div className="toolbar">
        <Badge tone={connected ? "ok" : "warn"}>{connected ? "streaming" : "connecting…"}</Badge>
        <Button variant="ghost" onClick={() => setPaused(!paused)} aria-pressed={paused}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="ghost" onClick={() => setLogs([])}>
          Clear
        </Button>
      </div>
      <LogTable logs={logs} onRequest={onRequest} />
    </>
  );
}

function History({
  manifest,
  filters,
  setFilters,
}: {
  manifest: Manifest;
  filters: { name: string; level: string; range: keyof typeof RANGES; requestId: string };
  setFilters: (f: typeof filters) => void;
}) {
  const logs = useAsync(
    () =>
      get<Log[]>("logs", {
        name: filters.name || undefined,
        level: filters.level || undefined,
        requestId: filters.requestId || undefined,
        since: filters.requestId ? undefined : Date.now() - RANGES[filters.range],
        limit: 500,
      }),
    [JSON.stringify(filters)],
  );
  return (
    <>
      <div className="toolbar">
        <Field label="Function">
          {(id) => (
            <select id={id} value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })}>
              <option value="">all</option>
              {manifest.functions.map((f) => (
                <option key={f.name}>{f.name}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Level">
          {(id) => (
            <select id={id} value={filters.level} onChange={(e) => setFilters({ ...filters, level: e.target.value })}>
              <option value="">all</option>
              {["call", "log", "info", "warn", "error"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Range">
          {(id) => (
            <select id={id} value={filters.range} onChange={(e) => setFilters({ ...filters, range: e.target.value as keyof typeof RANGES })}>
              {Object.keys(RANGES).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Request id">
          {(id) => <input id={id} value={filters.requestId} placeholder="any" onChange={(e) => setFilters({ ...filters, requestId: e.target.value })} />}
        </Field>
        <Button variant="ghost" onClick={logs.reload} className="push">
          Refresh
        </Button>
      </div>
      <ErrorNote error={logs.error} />
      {logs.loading && !logs.data ? <Spinner /> : <LogTable logs={logs.data ?? []} onRequest={(id) => setFilters({ ...filters, requestId: id })} />}
    </>
  );
}
