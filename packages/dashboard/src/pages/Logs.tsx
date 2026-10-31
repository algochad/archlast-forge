import { Fragment, useEffect, useState } from "react";
import { get, type Log } from "../api";
import { Icon } from "../brand";
import { clock, isoish, ms } from "../format";
import { Card, Chips, Refreshing, SearchBox, TelemetryOff, TraceLink } from "../kit";
import { attrsOf, useObs, useTelemetryOn, type LogRow } from "../obs";
import { href } from "../router";
import { Badge, Button, Empty, ErrorNote, Segmented, Skeleton } from "../ui";

const LEVELS = [
  { value: "", label: "All" },
  { value: "debug", label: "Debug" },
  { value: "log,info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error,fatal", label: "Error" },
];

export function Logs({ params }: { params: URLSearchParams }) {
  const telemetry = useTelemetryOn();
  const [mode, setMode] = useState<"history" | "live">(telemetry ? "history" : "live");
  return (
    <div className="obs-page">
      <div className="toolbar-row">
        <Segmented
          label="Source"
          value={mode}
          onChange={setMode}
          options={[
            { value: "history", label: "Stored · all servers" },
            { value: "live", label: "Stream · this server" },
          ]}
        />
      </div>
      {mode === "live" ? <Live /> : telemetry ? <History trace={params.get("trace") ?? ""} /> : <TelemetryOff />}
    </div>
  );
}

function History({ trace }: { trace: string }) {
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [before, setBefore] = useState<number | undefined>();
  const [older, setOlder] = useState<LogRow[]>([]);
  const logs = useObs<LogRow[]>("logs", { level: level || undefined, search: search || undefined, traceId: trace || undefined, limit: 200 });
  useEffect(() => {
    setOlder([]);
    setBefore(undefined);
  }, [level, search, trace]);
  useEffect(() => {
    if (!before) return;
    void get<LogRow[]>("obs.logs", { from: 0, to: before, level: level || undefined, search: search || undefined, traceId: trace || undefined, limit: 200 }).then((rows) => setOlder((o) => [...o, ...rows]));
  }, [before]);
  const rows = [...(logs.data ?? []), ...older];
  return (
    <>
      <div className="toolbar-row">
        <Chips label="Level" value={level} onChange={setLevel} options={LEVELS} />
        {trace && (
          <a className="chip" aria-checked="true" href={href("logs")}>
            trace {trace.slice(0, 8)}… <Icon name="x" size={12} />
          </a>
        )}
        <span className="push" />
        <Refreshing on={logs.refreshing} />
        <SearchBox value={search} onChange={setSearch} placeholder="Search messages…" />
      </div>
      <ErrorNote error={logs.error} />
      <Card className="flush">
        {logs.loading && !logs.data ? (
          <div style={{ padding: "1rem" }}>
            <Skeleton rows={8} />
          </div>
        ) : rows.length ? (
          <LogTable rows={rows} />
        ) : (
          <Empty icon="logs">No log lines in this range. What functions print with console.log, and logs other services send over OTLP, land here.</Empty>
        )}
        {rows.length >= 200 && (
          <div className="pager-row">
            <span className="muted small">{rows.length} lines</span>
            <Button variant="ghost" onClick={() => setBefore(Number(rows.at(-1)!.time))}>
              Load older lines
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

function LogTable({ rows }: { rows: LogRow[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="table-scroll">
      <table className="obs-table log-table">
        <thead>
          <tr>
            <th scope="col" style={{ width: "1.5rem" }} />
            <th scope="col">Time</th>
            <th scope="col">Level</th>
            <th scope="col">Context</th>
            <th scope="col">Message</th>
            <th scope="col">Trace</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => {
            const a = attrsOf(l.attrs);
            return (
              <Fragment key={`${l.id}-${i}`}>
                <tr className={`log-row ${l.level} clickable`} onClick={() => setOpen(open === i ? null : i)}>
                  <td>
                    <Icon name={open === i ? "chevron-down" : "chevron-right"} size={12} />
                  </td>
                  <td className="mono nowrap" title={isoish(Number(l.time))}>
                    {clock(Number(l.time))}
                  </td>
                  <td>
                    <span className={`log-level ${l.level}`}>{l.level}</span>
                  </td>
                  <td className="mono small nowrap" title={l.service}>
                    {l.name}
                  </td>
                  <td className="msg mono">{l.message}</td>
                  <td>{l.trace_id ? <TraceLink id={l.trace_id} /> : <span className="faint">—</span>}</td>
                </tr>
                {open === i && (
                  <tr className="log-expand">
                    <td />
                    <td colSpan={5}>
                      <pre className="json" style={{ maxHeight: "14rem" }}>
                        {l.message}
                      </pre>
                      <dl className="attr-grid" style={{ marginTop: "0.5rem" }}>
                        <dt>time</dt>
                        <dd>{isoish(Number(l.time))}</dd>
                        <dt>service</dt>
                        <dd>{l.service}</dd>
                        {l.instance && (
                          <>
                            <dt>instance</dt>
                            <dd>{l.instance}</dd>
                          </>
                        )}
                        {Object.entries(a).map(([k, v]) => (
                          <Fragment key={k}>
                            <dt>{k}</dt>
                            <dd>{String(v)}</dd>
                          </Fragment>
                        ))}
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type LiveLog = Log & { traceId?: string };

function Live() {
  const [logs, setLogs] = useState<LiveLog[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [calls, setCalls] = useState(true);
  useEffect(() => {
    get<LiveLog[]>("recentLogs").then((l) => setLogs(l.slice(-300).reverse()), () => {});
  }, []);
  useEffect(() => {
    if (paused) return;
    const es = new EventSource("/_admin/logs/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => setLogs((l) => [JSON.parse(e.data) as LiveLog, ...l].slice(0, 500));
    return () => es.close();
  }, [paused]);
  const shown = logs.filter((l) => calls || l.level !== "call");
  return (
    <>
      <div className="toolbar-row">
        <Badge tone={paused ? "neutral" : connected ? "ok" : "warn"}>{paused ? "paused" : connected ? "streaming" : "connecting…"}</Badge>
        <Button variant="ghost" onClick={() => setPaused(!paused)} aria-pressed={paused}>
          <Icon name={paused ? "play" : "pause"} size={14} /> {paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="ghost" onClick={() => setLogs([])}>
          Clear
        </Button>
        <label className="check-inline">
          <input type="checkbox" checked={calls} onChange={(e) => setCalls(e.target.checked)} /> Show function calls
        </label>
      </div>
      <Card className="flush">
        {shown.length ? (
          <div className="table-scroll">
            <table className="obs-table log-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Level</th>
                  <th scope="col">Function</th>
                  <th scope="col">Message</th>
                  <th scope="col" className="num">
                    Duration
                  </th>
                  <th scope="col">Trace</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l, i) => (
                  <tr key={i} className={`log-row ${l.level === "call" ? (l.ok ? "" : "error") : l.level}`}>
                    <td className="mono nowrap">{clock(l.time)}</td>
                    <td>{l.level === "call" ? <span className={`log-level ${l.ok ? "" : "error"}`}>{l.ok ? "ok" : "failed"}</span> : <span className={`log-level ${l.level}`}>{l.level}</span>}</td>
                    <td className="mono small nowrap">{l.name}</td>
                    <td className="msg mono">{l.level === "call" && l.ok ? <span className="faint">call</span> : l.message}</td>
                    <td className="num mono">{l.durationMs !== undefined ? ms(l.durationMs) : ""}</td>
                    <td>{l.traceId ? <TraceLink id={l.traceId} /> : <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="logs">Waiting for log lines from this server…</Empty>
        )}
      </Card>
    </>
  );
}
