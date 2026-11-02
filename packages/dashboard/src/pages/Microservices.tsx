import { setBackend, type Fleet, type Manifest } from "../api";
import { Icon } from "../brand";
import { RateBar, Spark } from "../charts";
import { ago, count, ms } from "../format";
import { Card, Refreshing } from "../kit";
import { useObs, useRange, type Stats } from "../obs";
import { href } from "../router";
import { Empty, ErrorNote, Skeleton } from "../ui";

type Service = Stats & { service: string; last: number; release: string | null; activity: number[]; attrs: Record<string, string | number | boolean>; firstSeen: number | null };
type NodeRow = { service: string; live: boolean };

const SDK_LABEL: Record<string, string> = { nodejs: "Node.js", javascript: "JavaScript", go: "Go", python: "Python", java: "Java", dotnet: ".NET", php: "PHP", ruby: "Ruby", rust: "Rust" };

/**
 * Every backend this dashboard shows: this app, its microservices (each one backend, reporting here through DASHBOARD_URL, and listed in
 * this app's MICROSERVICES so their data opens here too), and other services that send OpenTelemetry.
 */
export function Microservices({ manifest, fleet }: { manifest?: Manifest; fleet?: Fleet }) {
  const s = useObs<Service[]>("services");
  const nodes = useObs<NodeRow[]>("nodes");
  const range = useRange();
  if (s.loading && !s.data) return <Skeleton rows={6} />;
  if (!s.data) return <ErrorNote error={s.error} />;
  const configured = fleet?.services ?? [];
  const silent = configured.filter((c) => !s.data!.some((x) => x.service === c.name));
  if (!s.data.length && !silent.length) return <Empty icon="services">Nothing has reported in this range.</Empty>;
  /** The backend to open a service's data on: "" for this app, its name for a listed microservice, none for anything else. */
  const backendOf = (service: string) => (service === fleet?.self ? "" : configured.some((c) => c.name === service) ? service : undefined);
  const open = (backend: string, page: string) => (setBackend(backend), (location.hash = href(page)));
  const focus = (service: string, page: string) => (range.set({ service }), (location.hash = href(page)));
  return (
    <div className="obs-page">
      <div className="service-grid">
        {s.data.map((x) => {
          const sdk = String(x.attrs["telemetry.sdk.name"] ?? "");
          const lang = String(x.attrs["telemetry.sdk.language"] ?? "");
          const engine = sdk === "archlast-forge";
          const stale = Date.now() - x.last > 5 * 60_000;
          const backend = backendOf(x.service);
          const mine = nodes.data?.filter((n) => n.service === x.service) ?? [];
          const live = mine.filter((n) => n.live).length;
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
                  <dt>Nodes</dt>
                  <dd>{mine.length ? `${live} live${mine.length > live ? ` · ${mine.length - live} stopped` : ""}` : "—"}</dd>
                </div>
                <div>
                  <dt>Release</dt>
                  <dd>{x.release ? <code>{x.release}</code> : "—"}</dd>
                </div>
              </dl>
              <div className="attr-chips">
                {backend === "" ? <span className="badge accent">main app</span> : backend ? <span className="badge accent">microservice</span> : null}
                {engine ? (
                  <>
                    <span className="badge">Bun {String(x.attrs["process.runtime.version"] ?? "")}</span>
                    {x.attrs["forge.functions"] !== undefined ? (
                      <span className="badge">{String(x.attrs["forge.functions"])} functions</span>
                    ) : (
                      backend === "" && manifest && <span className="badge">{manifest.functions.length} functions</span>
                    )}
                    {x.attrs["forge.runtime_mode"] && <span className="badge">{String(x.attrs["forge.runtime_mode"])} runtime</span>}
                  </>
                ) : (
                  <>
                    <span className="badge">OpenTelemetry{lang ? ` · ${SDK_LABEL[lang] ?? lang}` : ""}</span>
                    {(x.attrs["deployment.environment.name"] ?? x.attrs["deployment.environment"]) ? (
                      <span className="badge">{String(x.attrs["deployment.environment.name"] ?? x.attrs["deployment.environment"])}</span>
                    ) : null}
                  </>
                )}
              </div>
              <div className="toolbar-row">
                {backend !== undefined && (
                  <button className="btn ghost" onClick={() => open(backend, "data")}>
                    <Icon name="data" size={14} /> Data and schema
                  </button>
                )}
                {mine.length > 0 && (
                  <button className="btn ghost" onClick={() => focus(x.service, "nodes")}>
                    <Icon name="nodes" size={14} /> Nodes
                  </button>
                )}
                <button className="btn ghost" onClick={() => (range.set({ service: range.service === x.service ? undefined : x.service }), (location.hash = href("overview")))}>
                  {range.service === x.service ? "Show all services" : "Focus on this service"}
                </button>
              </div>
            </Card>
          );
        })}
        {silent.map((c) => (
          <Card
            key={c.name}
            className="service-card"
            title={
              <>
                <Icon name="flame" size={16} /> {c.name}
              </>
            }
            extra={<span className="badge warn">not reporting</span>}
          >
            <p className="muted small">
              Listed in <code>MICROSERVICES</code> at <code>{c.url}</code>, with nothing from it in this range. It reports here when it starts with <code>DASHBOARD_URL</code> set to this
              app's address and the same <code>DASHBOARD_TOKEN</code>.
            </p>
            <div className="toolbar-row">
              <button className="btn ghost" onClick={() => open(c.name, "data")}>
                <Icon name="data" size={14} /> Data and schema
              </button>
            </div>
          </Card>
        ))}
      </div>
      <p className="muted small">
        A microservice is one backend. It reports here when it has <code>DASHBOARD_URL</code> pointing at this app and the same <code>DASHBOARD_TOKEN</code>, and this app's{" "}
        <code>MICROSERVICES</code> lists it so its data, schema and functions open here too (pick it at the top). Services that aren't archlast-forge engines report over OpenTelemetry: see{" "}
        <a href={href("keys")}>Ingest keys</a>.
      </p>
    </div>
  );
}
