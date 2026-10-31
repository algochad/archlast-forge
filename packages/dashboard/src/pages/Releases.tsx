import { Fragment, useState } from "react";
import { Icon } from "../brand";
import { Dumbbell } from "../charts";
import { ago, count, fullTime, ms, pct } from "../format";
import { Card, OpName, Refreshing } from "../kit";
import { useObs, type ReleaseImpact } from "../obs";
import { Empty, ErrorNote, Segmented, Skeleton } from "../ui";
import { VERDICT } from "./Overview";

const change = (a: number, b: number) => (a ? `${b >= a ? "+" : ""}${(((b - a) / a) * 100).toFixed(1)}%` : "");

export function Releases() {
  const r = useObs<(ReleaseImpact & { lastSeen: number })[]>("releases");
  const [metric, setMetric] = useState<"errors" | "p95">("errors");
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  if (r.loading && !r.data) return <Skeleton rows={8} />;
  if (!r.data) return <ErrorNote error={r.error} />;
  if (!r.data.length)
    return (
      <Empty icon="releases">
        No releases in this range. The engine records one whenever it starts with different code (a hash of forge/), or with the version your deploy names: FORGE_RELEASE, a platform's commit variable, or OpenTelemetry's service.version for other services.
      </Empty>
    );
  // The newest release with traffic on both sides, unless one is picked.
  const latest = r.data.find((x) => `${x.service}:${x.version}` === picked) ?? r.data.find((x) => x.before.count > 0 && x.after.count > 0) ?? r.data[0]!;
  const fmt = metric === "errors" ? (v: number) => pct(v) : (v: number) => ms(v);
  const value = (x: { errorRate: number; p95: number }) => (metric === "errors" ? x.errorRate : x.p95);
  return (
    <div className="obs-page">
      <Card
        title={
          <>
            Release impact <code className="release-version">{latest.version}</code> <span className="faint small">{latest.service}</span> <Refreshing on={r.refreshing} />
          </>
        }
        extra={
          <Segmented
            label="Measure"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "errors", label: "Error rate" },
              { value: "p95", label: "p95" },
            ]}
          />
        }
        footer={<span>Ring: the 30 minutes before the release. Dot: the 30 minutes after. Red moved the wrong way. The first row is every request together.</span>}
      >
        {latest.before.count === 0 ? (
          <p className="empty-inline">No traffic in the 30 minutes before {latest.version}: nothing to compare it with (a first deploy).</p>
        ) : (
        <Dumbbell
          format={fmt}
          rows={[
            { label: <strong>all traffic</strong>, before: value(latest.before), after: value(latest.after), worse: value(latest.after) > value(latest.before) * 1.05 },
            ...latest.operations.map((o) => ({ label: <OpName operation={o.operation} kind={o.kind} />, before: value(o.before), after: value(o.after), worse: value(o.after) > value(o.before) * 1.05 })),
          ]}
        />
        )}
      </Card>
      <Card className="flush" footer={<span>Rolling deploys serve both versions for a while, so the window after a release describes what users experienced across both. A version deployed again keeps its first appearance.</span>}>
        <table className="obs-table">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">Version</th>
              <th scope="col">Deployed</th>
              <th scope="col">Error rate</th>
              <th scope="col">Latency (avg)</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {r.data.map((rel) => {
              const id = `${rel.service}:${rel.version}`;
              return (
                <Fragment key={id}>
                  <tr className={`clickable${latest === rel ? " selected-row" : ""}`} onClick={() => (setOpen(open === id ? null : id), setPicked(id))} aria-expanded={open === id}>
                    <td>
                      <Icon name={open === id ? "chevron-down" : "chevron-right"} size={12} />
                    </td>
                    <td>
                      <code className="release-version">{rel.version}</code>
                      <div className="faint small">{rel.service}</div>
                    </td>
                    <td title={fullTime(rel.at)}>
                      {ago(rel.at)}
                      <div className="faint small">last seen {ago(rel.lastSeen)}</div>
                    </td>
                    <td className="mono">
                      <span className={rel.before.count && rel.after.errorRate > rel.before.errorRate + 0.005 ? "bad" : undefined}>
                        {rel.before.count ? pct(rel.before.errorRate) : "—"} → {pct(rel.after.errorRate)}
                      </span>
                      <div className="faint small">
                        {count(rel.before.count)} → {count(rel.after.count)} requests
                      </div>
                    </td>
                    <td className="mono">
                      {rel.before.count ? ms(rel.before.avg) : "—"} → {ms(rel.after.avg)} <span className="faint">{change(rel.before.avg, rel.after.avg)}</span>
                    </td>
                    <td>
                      <span className={`badge ${VERDICT[rel.verdict].tone}`}>{VERDICT[rel.verdict].label}</span>
                    </td>
                  </tr>
                  {open === id && (
                    <tr className="log-expand">
                      <td />
                      <td colSpan={5}>
                        <div className="grid-2" style={{ padding: "0.5rem 0" }}>
                          <div>
                            <div className="note-line">Operations, error rate before → after</div>
                            {rel.operations.length ? (
                              <Dumbbell format={(v) => pct(v)} rows={rel.operations.map((o) => ({ label: <OpName operation={o.operation} kind={o.kind} />, before: o.before.errorRate, after: o.after.errorRate, worse: o.after.errorRate > o.before.errorRate + 0.001 }))} />
                            ) : (
                              <p className="muted small">Not enough traffic on both sides to compare operations.</p>
                            )}
                          </div>
                          <div>
                            <div className="note-line">What changed in the code (time per request)</div>
                            {rel.changes.length ? (
                              <ul className="ranked">
                                {rel.changes.map((c) => (
                                  <li key={c.type + c.name}>
                                    <span className="op-name">
                                      {c.isNew && <span className="badge accent">new</span>}
                                      <code>{c.name}</code>
                                    </span>
                                    <span className="rk-value bad">+{ms(c.delta)}</span>
                                    <span className="rk-sub">
                                      {c.calls.toFixed(1)}× per request{c.isNew ? "" : `, was ${c.callsBefore.toFixed(1)}×`}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="muted small">No span got slower or more frequent.</p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
