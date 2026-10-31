import { useEffect, useState } from "react";
import { canWrite, get, post, type Admin } from "../api";
import { Icon } from "../brand";
import { Legend, TimeChart } from "../charts";
import { ago, count, fullTime } from "../format";
import { BackLink, Card, Chips, Delta, errorHref, Facts, Headline, OpName, opHref, Refreshing, SearchBox, StatusTag, TraceLink, userHref, usePages } from "../kit";
import { useObs } from "../obs";
import { href, navigate } from "../router";
import { Button, Empty, ErrorNote, Skeleton, useAction } from "../ui";

type ErrorItem = { fingerprint: string; type: string | null; message: string; status: number; handled: boolean | null; operation: string | null; state: string | null; count: number; users: number; anonymous: number; last: number; firstSeen: number | null };
type ErrorsData = { total: number; unhandled: number; handled: number; count: number; rate: number; previousRate: number; step: number; series: { t: number; unhandled: number; handled: number }[]; list: ErrorItem[] };

const ERROR_STACK = [
  { key: "handled", label: "handled", color: "var(--warn)" },
  { key: "unhandled", label: "unhandled", color: "var(--bad)" },
];

export function Errors({ params, admin }: { params: URLSearchParams; admin: Admin }) {
  const fp = params.get("fp");
  return fp ? <ErrorDetail fingerprint={fp} admin={admin} /> : <ErrorList />;
}

function ErrorList() {
  const [by, setBy] = useState<"issue" | "message">("issue");
  const [state, setState] = useState<"open" | "resolved" | "ignored">("open");
  const [search, setSearch] = useState("");
  const e = useObs<ErrorsData>("errors", { by, state: by === "issue" ? state : undefined, search: search || undefined });
  if (e.loading && !e.data) return <Skeleton rows={8} />;
  if (!e.data) return <ErrorNote error={e.error} />;
  const d = e.data;
  return (
    <div className="obs-page">
      <ErrorNote error={e.error} />
      <Card
        title={<>Errors <Refreshing on={e.refreshing} /></>}
        extra={<Legend items={[{ label: "handled", color: "var(--warn)", kind: "dot", value: count(d.handled) }, { label: "unhandled", color: "var(--bad)", kind: "dot", value: count(d.unhandled) }]} />}
      >
        <Headline value={d.rate * 100} unit="% of requests failed" format={(v) => v.toFixed(v < 1 ? 2 : 1)} sub={<Delta now={d.rate} before={d.previousRate} />} />
        <TimeChart points={d.series} step={d.step} height={140} marks={[{ kind: "lollipop", stack: ERROR_STACK }]} emptyLabel="No errors in this range" />
      </Card>
      <div className="toolbar-row">
        <Chips
          label="Group"
          value={by}
          onChange={setBy}
          options={[
            { value: "issue", label: <><Icon name="sparkle" size={13} /> Group into issues</> },
            { value: "message", label: "By message" },
          ]}
        />
        {by === "issue" && (
          <Chips
            label="State"
            value={state}
            onChange={setState}
            options={[
              { value: "open", label: "Open" },
              { value: "resolved", label: "Resolved" },
              { value: "ignored", label: "Ignored" },
            ]}
          />
        )}
        <span className="push" />
        <SearchBox value={search} onChange={setSearch} placeholder="Find an error…" />
      </div>
      <Card className="flush" footer={by === "issue" ? <span>An issue collects the occurrences of one bug: the same error class thrown from the same code, whatever the message says (ids, emails and numbers in it vary).</span> : <span>Every distinct message and status, as they were thrown.</span>}>
        <ErrorTable list={d.list} />
      </Card>
    </div>
  );
}

function ErrorTable({ list }: { list: ErrorItem[] }) {
  const { rows, pager } = usePages(list, 20);
  if (!list.length) return <Empty icon="errors">No errors here in this range.</Empty>;
  return (
    <>
      <div className="table-scroll">
        <table className="obs-table">
          <thead>
            <tr>
              <th scope="col">Error</th>
              <th scope="col">Where</th>
              <th scope="col" className="num">
                Count
              </th>
              <th scope="col">Users affected</th>
              <th scope="col" className="num">
                Last seen
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={`${e.fingerprint}${e.message}${e.status}`} className="clickable" onClick={() => navigate("errors", { fp: e.fingerprint })}>
                <td>
                  <div className="err-cell">
                    <span className="err-msg">
                      {e.type && <strong>{e.type}</strong>} <span className="mono">{e.message}</span>
                    </span>
                    <span className="err-tags">
                      <StatusTag status={e.status} />
                      {e.handled !== null && <span className={`badge ${e.handled ? "warn" : "bad"}`}>{e.handled ? "handled" : "unhandled"}</span>}
                      {e.firstSeen && Date.now() - e.firstSeen < 86_400_000 && <span className="badge accent">new</span>}
                    </span>
                  </div>
                </td>
                <td>{e.operation ? <OpName operation={e.operation} /> : <span className="faint">—</span>}</td>
                <td className="num mono">{count(e.count)}</td>
                <td>
                  <span>{count(e.users)} affected</span>
                  {e.anonymous > 0 && <div className="faint small">+{count(e.anonymous)} anonymous</div>}
                </td>
                <td className="num muted small" title={fullTime(e.last)}>
                  {ago(e.last)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

type ErrorDetailData = {
  group: { fingerprint: string; service: string; type: string; message: string; handled: boolean; status: number; operation: string; first_seen: number; last_seen: number; count: number; state: string; stack: string | null; sample_trace: string | null };
  count: number;
  users: { user_id: string; user_name: string | null; n: number; first: number; last: number }[];
  step: number;
  series: { t: number; count: number }[];
  occurrences: { trace_id: string; time: number; operation: string; kind: string; method: string | null; status: number; user_id: string | null; user_name: string | null; error_message: string; release: string | null; instance: string | null; duration: number }[];
};

function ErrorDetail({ fingerprint, admin }: { fingerprint: string; admin: Admin }) {
  const e = useObs<ErrorDetailData | null>("error", { fingerprint });
  const { run, busy } = useAction();
  if (e.loading && !e.data) return <Skeleton rows={8} />;
  if (!e.data) return e.error ? <ErrorNote error={e.error} /> : <Empty icon="errors">This issue isn't stored any more.</Empty>;
  const { group: g, occurrences } = e.data;
  const latest = occurrences[0];
  const setState = (state: string) => run(() => post("obs.setErrorState", { fingerprint, state }), state === "open" ? "Reopened" : state === "resolved" ? "Marked resolved: it reopens if it happens again" : "Ignored").then(e.reload);
  return (
    <div className="obs-page">
      <BackLink to={href("errors")}>All errors</BackLink>
      <Card
        title={
          <span className="err-msg">
            <strong>{g.type}</strong> <span className="mono">{g.message}</span>
          </span>
        }
        className="flush"
        extra={
          canWrite(admin) && (
            <>
              {g.state !== "resolved" && (
                <Button variant="ghost" disabled={busy} onClick={() => setState("resolved")}>
                  <Icon name="check" size={14} /> Resolve
                </Button>
              )}
              {g.state !== "ignored" && (
                <Button variant="ghost" disabled={busy} onClick={() => setState("ignored")}>
                  Ignore
                </Button>
              )}
              {g.state !== "open" && (
                <Button variant="ghost" disabled={busy} onClick={() => setState("open")}>
                  Reopen
                </Button>
              )}
            </>
          )
        }
      >
        <Facts
          items={[
            { label: "State", value: <span className={`badge ${g.state === "open" ? "bad" : g.state === "resolved" ? "ok" : ""}`}>{g.state}</span> },
            { label: "Status", value: <StatusTag status={g.status} /> },
            { label: "Kind", value: g.handled ? "handled (thrown on purpose)" : "unhandled", tone: g.handled ? undefined : "bad" },
            { label: "In range", value: `${count(e.data.count)} times` },
            { label: "Users affected", value: count(e.data.users.length) },
            { label: "First seen", value: ago(g.first_seen) },
            { label: "Last seen", value: ago(g.last_seen) },
            { label: "All time", value: `${count(g.count)} times` },
          ]}
        />
      </Card>
      <div className="grid-3-1">
        <Card title="Occurrences" extra={<Refreshing on={e.refreshing} />}>
          <TimeChart points={e.data.series} step={e.data.step} height={130} marks={[{ kind: "lollipop", stack: [{ key: "count", label: "occurrences", color: g.handled ? "var(--warn)" : "var(--bad)" }] }]} />
        </Card>
        <Card title="Latest occurrence">
          {latest ? (
            <div className="stack" style={{ gap: "0.5rem" }}>
              <a className="op-link" href={opHref(latest.kind, latest.operation)}>
                <OpName operation={latest.operation} kind={latest.kind} />
              </a>
              <div className="muted small">
                {ago(Number(latest.time))}
                {latest.release && <> · release <code>{latest.release}</code></>}
                {latest.user_id && (
                  <>
                    {" "}
                    · <a href={userHref(latest.user_id)}>{latest.user_name ?? latest.user_id}</a>
                  </>
                )}
              </div>
              <a className="btn primary" href={href("trace", { id: latest.trace_id })}>
                Open trace <Icon name="arrow" size={14} />
              </a>
            </div>
          ) : (
            <p className="muted">None in this range.</p>
          )}
        </Card>
      </div>
      {g.stack && (
        <Card title="Stack trace">
          <StackTrace stack={g.stack} />
        </Card>
      )}
      <div className="grid-2">
        <Card title={<>Affected users <span className="badge">{e.data.users.length}</span></>} className="flush">
          {e.data.users.length ? (
            <table className="obs-table">
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col" className="num">
                    Occurrences
                  </th>
                  <th scope="col" className="num">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.data.users.map((u) => (
                  <tr key={u.user_id} className="clickable" onClick={() => navigate("users", { id: u.user_id })}>
                    <td>{u.user_name ?? u.user_id}</td>
                    <td className="num mono">{count(Number(u.n))}</td>
                    <td className="num muted small">{ago(Number(u.last))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty-inline">Only anonymous callers so far.</p>
          )}
        </Card>
        <Card title="All occurrences" className="flush">
          <table className="obs-table">
            <thead>
              <tr>
                <th scope="col">Trace</th>
                <th scope="col">User</th>
                <th scope="col">Message</th>
                <th scope="col" className="num">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {occurrences.slice(0, 25).map((o) => (
                <tr key={o.trace_id} className="clickable" onClick={() => navigate("trace", { id: o.trace_id })}>
                  <td>
                    <TraceLink id={o.trace_id} />
                  </td>
                  <td>{o.user_name ?? o.user_id ?? <span className="faint">anonymous</span>}</td>
                  <td className="msg mono small">{o.error_message}</td>
                  <td className="num muted small">{ago(Number(o.time))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <p className="note-line">
        Fingerprint <b>{fingerprint}</b> · <a href={errorHref(fingerprint)}>link to this issue</a>
      </p>
    </div>
  );
}

type Frame = { fn: string; file: string; line: number; col: number; lib: boolean; raw: string };

/** JavaScript stack frames ("at fn (file:line:col)"); anything else is shown as it came. */
export function parseStack(stack: string): { head: string; frames: Frame[] } {
  const lines = stack.split("\n");
  const frames: Frame[] = [];
  const head: string[] = [];
  for (const l of lines) {
    const m = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(l);
    if (m) frames.push({ fn: m[1] ?? "<anonymous>", file: m[2]!, line: Number(m[3]), col: Number(m[4]), lib: /node_modules|^node:|^bun:|\(native\)|\/forge-runtime\/|\/packages\/runtime\/src\//.test(m[2]!), raw: l.trim() });
    else if (!frames.length) head.push(l);
  }
  return { head: head.join("\n"), frames };
}

function StackTrace({ stack }: { stack: string }) {
  const { head, frames } = parseStack(stack);
  const [open, setOpen] = useState<number | null>(() => {
    const i = frames.findIndex((f) => !f.lib);
    return i < 0 ? null : i;
  });
  const [showLib, setShowLib] = useState(false);
  if (!frames.length) return <pre className="json">{stack}</pre>;
  const libs = frames.filter((f) => f.lib).length;
  return (
    <div className="frames">
      <pre className="json" style={{ maxHeight: "6rem" }}>
        {head}
      </pre>
      {frames.map((f, i) =>
        f.lib && !showLib ? null : (
          <div key={i} className={`frame${f.lib ? " lib" : ""}`}>
            <button type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <Icon name={open === i ? "chevron-down" : "chevron-right"} size={12} />
              <span className="fn">{f.fn}</span>
              <span className="loc" title={f.file}>
                {f.file.split("/").slice(-2).join("/")}:{f.line}:{f.col}
              </span>
            </button>
            {open === i && <Source file={f.file} line={f.line} />}
          </div>
        ),
      )}
      {libs > 0 && (
        <button className="link small" onClick={() => setShowLib(!showLib)}>
          {showLib ? "Hide" : "Show"} {libs} {libs === 1 ? "frame" : "frames"} in dependencies and the runtime
        </button>
      )}
    </div>
  );
}

function Source({ file, line }: { file: string; line: number }) {
  const [src, setSrc] = useState<{ start: number; lines: string[]; file: string } | null | undefined>();
  useEffect(() => {
    get<{ start: number; lines: string[]; file: string } | null>("obs.source", { file, line }).then(setSrc, () => setSrc(null));
  }, [file, line]);
  if (src === undefined) return <Skeleton rows={3} />;
  if (!src) return <p className="empty-inline">The source isn't available here (not part of this project, or on another machine).</p>;
  return (
    <pre className="source" aria-label={`${src.file} around line ${line}`}>
      {src.lines.map((l, i) => (
        <div key={i} className={src.start + i === line ? "here" : undefined}>
          <span>{src.start + i}</span>
          <span>{l || " "}</span>
        </div>
      ))}
    </pre>
  );
}

