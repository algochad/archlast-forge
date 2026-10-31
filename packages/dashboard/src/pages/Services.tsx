import type { Manifest } from "../api";
import { Icon } from "../brand";
import { RateBar, Spark } from "../charts";
import { ago, count, ms } from "../format";
import { Card, Refreshing } from "../kit";
import { useObs, useRange, type Stats } from "../obs";
import { href } from "../router";
import { Empty, ErrorNote, Skeleton } from "../ui";

type Service = Stats & { service: string; last: number; release: string | null; activity: number[]; attrs: Record<string, string | number | boolean>; firstSeen: number | null };

const SDK_LABEL: Record<string, string> = { nodejs: "Node.js", javascript: "JavaScript", go: "Go", python: "Python", java: "Java", dotnet: ".NET", php: "PHP", ruby: "Ruby", rust: "Rust" };

export function Services({ manifest }: { manifest?: Manifest }) {
  const s = useObs<Service[]>("services");
  const range = useRange();
  if (s.loading && !s.data) return <Skeleton rows={6} />;
  if (!s.data) return <ErrorNote error={s.error} />;
  if (!s.data.length) return <Empty icon="services">Nothing has reported in this range.</Empty>;
  return (
    <div className="obs-page">
      <div className="service-grid">
        {s.data.map((x) => {
          const sdk = String(x.attrs["telemetry.sdk.name"] ?? "");
          const lang = String(x.attrs["telemetry.sdk.language"] ?? "");
          const engine = sdk === "archlast-forge";
          const stale = Date.now() - x.last > 5 * 60_000;
          return (
            <Card
              key={x.service}
              className={`service-card${range.service === x.service ? " picked" : ""}`}
              title={
                <>
                  <Icon name={engine ? "flame" : "box"} size={16} /> {x.service} <Refreshing on={s.refreshing} />
                </>
              }
              extra={<span className={`badge ${stale ? "warn" : "ok"}`}>{stale ? `quiet · ${ago(x.last)}` : "reporting"}</span>}
            >
              <Spark values={x.activity} bars height={34} />
              <dl className="facts compact">
                <div>
                  <dt>Requests</dt>
                  <dd>{count(x.count)}</dd>
                </div>
                <div>
                  <dt>Avg</dt>
                  <dd>{ms(x.avg)}</dd>
                </div>
                <div>
                  <dt>Errors</dt>
                  <dd>
                    <RateBar rate={x.count ? (x.errors + x.clientErrors) / x.count : 0} />
                  </dd>
                </div>
                <div>
                  <dt>Release</dt>
                  <dd>{x.release ? <code>{x.release}</code> : "—"}</dd>
                </div>
              </dl>
              <div className="attr-chips">
                {engine ? (
                  <>
                    <span className="badge accent">this engine</span>
                    <span className="badge">Bun {String(x.attrs["process.runtime.version"] ?? "")}</span>
                    {manifest && <span className="badge">{manifest.functions.length} functions</span>}
                    {x.attrs["forge.runtime_mode"] && <span className="badge">{String(x.attrs["forge.runtime_mode"])} runtime</span>}
                  </>
                ) : (
                  <>
                    <span className="badge">OpenTelemetry{lang ? ` · ${SDK_LABEL[lang] ?? lang}` : ""}</span>
                    {x.attrs["deployment.environment.name"] ?? x.attrs["deployment.environment"] ? <span className="badge">{String(x.attrs["deployment.environment.name"] ?? x.attrs["deployment.environment"])}</span> : null}
                  </>
                )}
                {x.attrs["host.name"] && <span className="badge mono">{String(x.attrs["host.name"])}</span>}
              </div>
              <div className="toolbar-row">
                <button className="btn ghost" onClick={() => (range.set({ service: range.service === x.service ? undefined : x.service }), (location.hash = href("overview")))}>
                  {range.service === x.service ? "Show all services" : "Focus on this service"}
                </button>
              </div>
            </Card>
          );
        })}
      </div>
      <p className="muted small">
        Another service reports here by pointing its OpenTelemetry exporter at this engine: see <a href={href("keys")}>Ingest keys</a>.
      </p>
    </div>
  );
}
