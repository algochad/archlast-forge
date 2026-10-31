import { Legend, TimeChart, Treemap } from "../charts";
import { ago, count, ms, msParts, pct, perMinute, plural } from "../format";
import { Callout, Card, Delta, errorHref, Headline, OpName, opHref, Refreshing } from "../kit";
import { useObs, useRange, type Overview as OverviewData, type ReleaseImpact } from "../obs";
import { href } from "../router";
import { Empty, ErrorNote, Skeleton } from "../ui";

export const STATUS_STACK = [
  { key: "ok", label: "1/2/3xx", color: "var(--viz-quiet)" },
  { key: "clientErrors", label: "4xx", color: "var(--warn)" },
  { key: "errors", label: "5xx", color: "var(--bad)" },
];
const TILE_COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"];

export function Overview() {
  const o = useObs<OverviewData>("overview");
  const range = useRange();
  if (o.loading && !o.data) return <Skeleton rows={8} />;
  if (!o.data) return <ErrorNote error={o.error} />;
  const d = o.data;
  const r = range.resolve();
  const width = r.to - r.from;
  const avgUnit = msParts(d.requests.avg)[1];
  const tiles = d.code.items.slice(0, 9);
  const rest = d.code.items.slice(9).reduce((s, c) => s + c.self, 0);
  return (
    <div className="obs-page">
      <ErrorNote error={o.error} />
      {d.release?.verdict === "regression" && <RegressionCallout release={d.release} />}
      <div className="grid-2">
        <Card
          title={
            <>
              Requests <Refreshing on={o.refreshing} />
            </>
          }
          extra={<Legend items={STATUS_STACK.map((s) => ({ label: s.label, color: s.color }))} />}
        >
          <Headline value={d.requests.count} sub={<><span>{perMinute(d.requests.count, width).toFixed(1)}/min</span><Delta now={d.requests.count} before={d.requests.previous} upIsGood /></>} />
          <TimeChart points={d.requests.series} step={d.step} marks={[{ kind: "bars", stack: STATUS_STACK }]} />
          {d.requests.cached > 0 && <p className="note-line">{pct(d.requests.cached / Math.max(1, d.requests.count))} served from the query cache</p>}
        </Card>
        <Card title="Duration" extra={<Legend items={[{ label: "avg", color: "var(--viz-1)", kind: "line" }, { label: "p95", color: "var(--viz-1)", kind: "dashed" }]} />}>
          <Headline value={d.requests.avg} unit={avgUnit} format={(v) => msParts(v)[0]} sub={<><span>p95 {ms(d.requests.p95)}</span><span>p99 {ms(d.requests.p99)}</span>{d.requests.apdex !== null && <span>apdex {d.requests.apdex.toFixed(2)}</span>}</>} />
          <TimeChart
            points={d.requests.series}
            step={d.step}
            format={(v) => ms(v, 0)}
            marks={[
              { kind: "line", key: "avg", label: "avg", color: "var(--viz-1)", area: true },
              { kind: "line", key: "p95", label: "p95", color: "var(--viz-1)", dashed: true },
            ]}
          />
        </Card>
      </div>
      <div className="grid-3">
        <Card title="Performance outliers" extra={<span className="note-line">p95 against budget</span>}>
          {d.outliers.length ? (
            <ul className="ranked">
              {d.outliers.slice(0, 5).map((x) => (
                <li key={`${x.kind}${x.operation}`}>
                  <a className="op-link" href={opHref(x.kind, x.operation)}>
                    <OpName operation={x.operation} kind={x.kind} />
                  </a>
                  <span className={`rk-value${x.ratio > 1 ? " bad" : ""}`}>{ms(x.p95)}</span>
                  <span className="rk-bar">
                    <i className={x.ratio > 1 ? "bad" : undefined} style={{ width: `${Math.min(100, (x.ratio / Math.max(1, d.outliers[0]!.ratio)) * 100)}%` }} />
                  </span>
                  <span className="rk-sub">{x.ratio >= 1 ? `${x.ratio.toFixed(1)}× budget` : `budget ${ms(x.threshold)}`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon="requests">No requests in this range.</Empty>
          )}
        </Card>
        <Card title="High throughput" extra={<span className="note-line">calls</span>}>
          {d.throughput.length ? (
            <ul className="ranked">
              {d.throughput.slice(0, 5).map((x) => (
                <li key={`${x.kind}${x.operation}`}>
                  <a className="op-link" href={opHref(x.kind, x.operation)}>
                    <OpName operation={x.operation} kind={x.kind} />
                  </a>
                  <span className="rk-value">{count(x.count)}</span>
                  <span className="rk-bar">
                    <i style={{ width: `${(x.count / Math.max(1, d.throughput[0]!.count)) * 100}%` }} />
                  </span>
                  <span className="rk-sub">{pct(x.share)} of requests</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon="requests">No requests in this range.</Empty>
          )}
        </Card>
        <Card title="Where the time goes" extra={<span className="note-line">own time</span>}>
          {tiles.length ? (
            <>
              <Treemap
                height={190}
                tiles={[
                  ...tiles.map((t, i) => ({ id: `${t.type}:${t.namespace}`, label: t.namespace, sub: ms(t.self), value: t.self, color: TILE_COLORS[i % TILE_COLORS.length]! })),
                  ...(rest > 0 ? [{ id: "rest", label: `${d.code.items.length - 9} more`, value: rest, color: "var(--viz-quiet)" }] : []),
                ]}
                onPick={() => (location.hash = href("hotspots"))}
              />
              <p className="note-line">
                <b>{pct(tiles.slice(0, 3).reduce((s, t) => s + t.share, 0))}</b> of own time in the top {Math.min(3, tiles.length)}
              </p>
            </>
          ) : (
            <Empty icon="hotspots">Spans show up here once requests run code.</Empty>
          )}
        </Card>
      </div>
      <div className="grid-3-1">
        <Card title="Errors" extra={<Legend items={[{ label: "handled", color: "var(--warn)", kind: "dot", value: count(d.errors.handled) }, { label: "unhandled", color: "var(--bad)", kind: "dot", value: count(d.errors.unhandled) }]} />}>
          <Headline value={d.errors.rate * 100} unit="% unhandled" format={(v) => v.toFixed(v < 1 ? 2 : 1)} sub={<span>{pct(d.errors.rateWithHandled)} with handled errors</span>} />
          <TimeChart
            points={d.errors.series.map((p) => ({ t: p.t, handled: p.handled, unhandled: p.unhandled }))}
            step={d.step}
            height={120}
            marks={[{ kind: "lollipop", stack: [{ key: "handled", label: "handled", color: "var(--warn)" }, { key: "unhandled", label: "unhandled", color: "var(--bad)" }] }]}
            emptyLabel="No errors in this range"
          />
        </Card>
        <Card title={<>Issues <span className="badge">{d.issues.length}</span></>} extra={<a className="btn ghost" href={href("errors")}>View all</a>}>
          {d.issues.length ? (
            <ul className="ranked">
              {d.issues.map((i) => (
                <li key={i.fingerprint}>
                  <a href={errorHref(i.fingerprint)} className="plain-link" style={{ minWidth: 0 }}>
                    <span className="issue-title">
                      <strong>{i.type}</strong> {i.message}
                    </span>
                  </a>
                  <span className={`rk-value${i.handled ? "" : " bad"}`}>{count(i.count)}×</span>
                  <span className="rk-sub" style={{ gridColumn: "1 / -1", textAlign: "left" }}>
                    {i.status} · {plural(i.users, "user")} · {ago(i.last)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon="errors">No open issues in this range.</Empty>
          )}
        </Card>
      </div>
      <div className="grid-2">
        <Card title="Jobs" extra={<Legend items={[{ label: "completed", color: "var(--viz-quiet)" }, { label: "failed", color: "var(--bad)" }]} />}>
          <Headline value={d.jobs.count} unit="runs" sub={<><span>{pct(d.jobs.count ? (d.jobs.errors + d.jobs.clientErrors) / d.jobs.count : 0)} failed</span><Delta now={d.jobs.count} before={d.jobs.previous} upIsGood /></>} />
          <TimeChart
            points={d.jobs.series.map((p) => ({ t: p.t, done: p.ok, failed: p.errors + p.clientErrors }))}
            step={d.step}
            height={120}
            marks={[{ kind: "bars", stack: [{ key: "done", label: "completed", color: "var(--viz-quiet)" }, { key: "failed", label: "failed", color: "var(--bad)" }] }]}
            emptyLabel="No jobs ran in this range"
          />
        </Card>
        <LastRelease release={d.release} />
      </div>
    </div>
  );
}

function RegressionCallout({ release }: { release: ReleaseImpact }) {
  const worst = release.operations[0];
  return (
    <Callout
      tone="bad"
      icon="releases"
      title={`${release.version} looks like a regression`}
      actions={
        <a className="btn ghost" href={href("releases")}>
          Compare releases
        </a>
      }
    >
      Since {release.version} went out {ago(release.at)}, the error rate moved from {pct(release.before.errorRate)} to {pct(release.after.errorRate)} and p95 from {ms(release.before.p95)} to {ms(release.after.p95)}.
      {worst && (
        <>
          {" "}
          The worst-hit operation is <code>{worst.operation}</code>.
        </>
      )}
    </Callout>
  );
}

export const VERDICT: Record<ReleaseImpact["verdict"], { label: string; tone: string }> = {
  regression: { label: "Regression", tone: "bad" },
  improvement: { label: "Improvement", tone: "ok" },
  stable: { label: "Stable", tone: "neutral" },
  early: { label: "Measuring", tone: "accent" },
  quiet: { label: "Too little traffic", tone: "neutral" },
};

function LastRelease({ release }: { release: ReleaseImpact | null }) {
  return (
    <Card title="Last release" extra={<a className="btn ghost" href={href("releases")}>View all</a>}>
      {release ? (
        <div className="release-summary">
          <div className="toolbar-row">
            <code className="release-version">{release.version}</code>
            <span className={`badge ${VERDICT[release.verdict].tone}`}>{VERDICT[release.verdict].label}</span>
            <span className="muted small">deployed {ago(release.at)}</span>
          </div>
          <dl className="facts">
            <div>
              <dt>Error rate</dt>
              <dd className={release.after.errorRate > release.before.errorRate + 0.005 ? "bad" : undefined}>
                {pct(release.before.errorRate)} → {pct(release.after.errorRate)}
              </dd>
            </div>
            <div>
              <dt>Latency avg</dt>
              <dd>
                {ms(release.before.avg)} → {ms(release.after.avg)}
              </dd>
            </div>
            <div>
              <dt>Requests</dt>
              <dd>
                {count(release.before.count)} → {count(release.after.count)}
              </dd>
            </div>
          </dl>
          {release.changes.length > 0 && (
            <div>
              <div className="note-line">What changed in the code</div>
              <ul className="ranked">
                {release.changes.slice(0, 3).map((c) => (
                  <li key={`${c.type}${c.name}`}>
                    <span className="op-name">
                      {c.isNew && <span className="badge accent">new</span>}
                      <code>{c.name}</code>
                    </span>
                    <span className="rk-value bad">+{ms(c.delta)}/req</span>
                    <span className="rk-sub">
                      {c.calls.toFixed(c.calls < 10 ? 1 : 0)}× per request{!c.isNew && c.callsBefore ? ` (was ${c.callsBefore.toFixed(c.callsBefore < 10 ? 1 : 0)}×)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <Empty icon="releases">No releases yet. Each deploy is recorded when the engine loads new code, or from FORGE_RELEASE / your platform's commit variable.</Empty>
      )}
    </Card>
  );
}
