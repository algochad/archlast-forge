import { canWrite, formatBytes, formatDuration, get, hitRate, post, type Admin, type CacheInfo } from "../api";
import { axisTime } from "../format";
import { useObs, useRange, useTelemetryOn } from "../obs";
import { Badge, Button, Empty, ErrorNote, LineChart, Skeleton, Stat, useAction, useAsync } from "../ui";

type Bucket = { start: number; cacheHits: number | null; cacheMisses: number | null; cacheCoalesced: number | null };
type Sums = "cache_hits" | "cache_misses" | "cache_shared";
type RuntimeSeries = { series: { role?: string; points: ({ t: number } & Partial<Record<Sums, number | null>>)[] }[] };
type Operations = { operations: { kind: string; operation: string; count: number; cached: number; avg: number }[] };
/** One function's row: from the saved requests over the range, or from this server's counters when telemetry is off. */
type Row = { name: string; perUser: boolean; cached: number; runs: number; savedMs: number };
const pct = (n: number | null) => (n === null ? "—" : `${n < 10 && n > 0 ? n.toFixed(1) : Math.round(n)}%`);

/** The servers' cache counters, from the runtime samples each one records every 10 s (the change since the last), summed per time bucket. */
function buckets(r: RuntimeSeries): Bucket[] {
  const servers = r.series.filter((s) => s.role === "server");
  const sum = (i: number, k: Sums) => {
    const values = servers.map((s) => s.points[i]?.[k]).filter((v): v is number => typeof v === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return (servers[0]?.points ?? []).map((p, i) => ({ start: p.t, cacheHits: sum(i, "cache_hits"), cacheMisses: sum(i, "cache_misses"), cacheCoalesced: sum(i, "cache_shared") }));
}

/** Per function, across queries and their live re-runs. Time saved is an estimate: the calls answered from the cache times the average time of a run. */
function rowsOf(o: Operations, perUser: Set<string>): Row[] {
  const by = new Map<string, Row & { totalMs: number }>();
  for (const x of o.operations) {
    if (x.kind !== "query" && x.kind !== "live") continue;
    const r = by.get(x.operation) ?? { name: x.operation, perUser: perUser.has(x.operation), cached: 0, runs: 0, savedMs: 0, totalMs: 0 };
    r.cached += x.cached;
    r.runs += x.count - x.cached;
    r.totalMs += x.avg * x.count;
    by.set(x.operation, r);
  }
  return [...by.values()].map((r) => ({ ...r, savedMs: r.runs ? r.cached * (r.totalMs / r.runs) : 0 }));
}

export function Cache({ admin }: { admin: Admin }) {
  const telemetry = useTelemetryOn();
  const range = useRange();
  const cache = useAsync(() => get<CacheInfo>("cache"), [], { interval: 4000 });
  // What was recorded over the range: it outlives restarts. The counters in `cache` start at zero with each server process.
  const history = useObs<RuntimeSeries>("runtime");
  const operations = useObs<Operations>("requests");
  const { run, busy } = useAction();
  const c = cache.data;
  if (cache.loading && !c) return <Skeleton rows={6} />;
  if (!c) return <ErrorNote error={cache.error} />;
  if (!c.enabled) return <Empty icon="cache">The query cache is off. Set CACHE_TTL_MS to a number of milliseconds to turn it on (the default is 60000).</Empty>;
  if (telemetry && !(history.data && operations.data) && !(history.error || operations.error)) return <Skeleton rows={6} />;

  const stored = telemetry && history.data !== undefined && operations.data !== undefined;
  const b = history.data ? buckets(history.data) : [];
  const total = (k: "cacheHits" | "cacheMisses" | "cacheCoalesced") => b.reduce((n, x) => n + (x[k] ?? 0), 0);
  const counts = stored ? { hits: total("cacheHits"), coalesced: total("cacheCoalesced"), misses: total("cacheMisses") } : c;
  const rate = hitRate(counts);
  const served = counts.hits + counts.coalesced;
  const functions: Row[] = stored
    ? rowsOf(operations.data!, new Set(c.functions.filter((f) => f.perUser).map((f) => f.name)))
    : c.functions.map((f) => ({ name: f.name, perUser: f.perUser, cached: f.hits + f.coalesced, runs: f.misses, savedMs: f.savedMs }));
  functions.sort((x, y) => y.cached + y.runs - (x.cached + x.runs));
  const saved = functions.reduce((n, f) => n + f.savedMs, 0);
  const { from, to } = range.resolve();
  const labels = b.map((x) => axisTime(x.start, to - from));
  const bucketServed = (x: Bucket) => (x.cacheHits === null ? null : x.cacheHits + (x.cacheCoalesced ?? 0));
  const bucketRate = (x: Bucket) => hitRate({ hits: x.cacheHits ?? 0, coalesced: x.cacheCoalesced ?? 0, misses: x.cacheMisses ?? 0 });
  const since = "since this server started";

  return (
    <div className="stack">
      <section className="stats" aria-label="Cache summary">
        <Stat
          label="Hit rate"
          icon="cache"
          tone={rate === null ? undefined : rate >= 50 ? "ok" : "ember"}
          value={pct(rate)}
          hint={rate === null ? (stored ? "No queries in this range" : "No queries yet") : `${served.toLocaleString()} of ${(served + counts.misses).toLocaleString()} calls`}
          trend={b.map((x) => bucketRate(x) ?? 0)}
        />
        <Stat
          label="Served from cache"
          icon="bolt"
          value={served.toLocaleString()}
          hint={`${counts.hits.toLocaleString()} hits · ${counts.coalesced.toLocaleString()} shared a run`}
          trend={b.map((x) => bucketServed(x) ?? 0)}
        />
        <Stat
          label="Function runs"
          icon="functions"
          value={counts.misses.toLocaleString()}
          hint={stored ? "calls that ran the function" : c.skipped ? `${c.skipped.toLocaleString()} results not kept (changed mid-run, too big, or per user)` : "every result was kept"}
          trend={b.map((x) => x.cacheMisses ?? 0)}
        />
        <Stat
          label="In the cache"
          icon="data"
          value={c.entries === null ? "—" : c.entries.toLocaleString()}
          hint={c.backend === "redis" ? "held in Redis, now" : `${formatBytes(c.bytes)} of ${formatBytes(c.maxBytes)}, now`}
        />
      </section>
      <section className="stats" aria-label="Cache details">
        <Stat
          label="Time saved"
          icon="scheduled"
          tone={saved > 0 ? "ember" : undefined}
          value={formatDuration(saved)}
          hint={stored ? "estimated: calls answered from the cache times the average request time of a run" : "estimated, at each function's average run time"}
        />
        <Stat label="Evicted by writes" icon="flame" value={c.invalidatedEntries.toLocaleString()} hint={`dropped when a mutation changed what they read, ${since}`} />
        <Stat
          label="Evicted for space"
          icon="settings"
          value={c.evictions.toLocaleString()}
          hint={c.backend === "redis" ? "Redis manages its own memory" : `pushed out to stay within the memory limit, ${since}`}
        />
        <Stat label="Entry lifetime" icon="scheduled" value={formatDuration(c.ttlMs)} hint="at most; a write evicts sooner" />
      </section>

      <section className="panel stack" aria-label="Hits and misses over time">
        <div className="toolbar">
          <h3>Over time</h3>
          <span className="muted small">all servers, sampled every 10 s</span>
        </div>
        {telemetry ? (
          <>
            <ErrorNote error={history.error} />
            <div className="charts">
              <LineChart
                title="Served from cache vs. run"
                labels={labels}
                series={[
                  { name: "from cache", values: b.map(bucketServed), color: "var(--ok)" },
                  { name: "function runs", values: b.map((x) => x.cacheMisses), color: "var(--ember)" },
                ]}
              />
              <LineChart
                title="Hit rate"
                unit="%"
                labels={labels}
                series={[{ name: "hit rate", values: b.map((x) => (x.cacheHits === null ? null : bucketRate(x))), color: "var(--ember)" }]}
              />
            </div>
          </>
        ) : (
          <p className="muted">
            The history comes from telemetry, which is off on this server (<code>TELEMETRY=off</code>). The numbers above count since it started.
          </p>
        )}
      </section>

      <section className="panel stack" aria-label="By function">
        <div className="toolbar">
          <h3>By function</h3>
          <span className="muted small">{stored ? "all servers, over the range above" : "this server, since it started"}</span>
          <span className="push" />
          {canWrite(admin) && (
            <Button
              variant="ghost"
              disabled={busy || !c.entries}
              onClick={() => confirm("Empty the query cache? Every query runs once more to refill it.") && run(() => post("clearCache"), "Cache cleared").then(cache.reload)}
            >
              Clear cache
            </Button>
          )}
        </div>
        {functions.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Function</th>
                  <th scope="col">Hit rate</th>
                  <th scope="col" className="num">
                    From cache
                  </th>
                  <th scope="col" className="num">
                    Runs
                  </th>
                  <th scope="col" className="num">
                    Saved
                  </th>
                </tr>
              </thead>
              <tbody>
                {functions.map((f) => {
                  const r = hitRate({ hits: f.cached, coalesced: 0, misses: f.runs });
                  return (
                    <tr key={f.name}>
                      <td>
                        <code className="field-name">{f.name}</code> {f.perUser && <Badge tone="accent">per user</Badge>}
                      </td>
                      <td>
                        <span className="meter-cell">
                          <span className="meter" role="img" aria-label={`${pct(r)} hit rate`}>
                            <i style={{ width: `${r ?? 0}%` }} />
                          </span>
                          <span className="small num">{pct(r)}</span>
                        </span>
                      </td>
                      <td className="num">{f.cached.toLocaleString()}</td>
                      <td className="num">{f.runs.toLocaleString()}</td>
                      <td className="num">{f.savedMs ? formatDuration(f.savedMs) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="cache">No queries ran in this range. Call one from your app and it shows up here.</Empty>
        )}
        <p className="muted small">
          <b>From cache</b> counts calls answered from the cache, including those that arrived while an identical call was already running and used its result. A <b>run</b> executed the
          function. Entries are evicted the moment a mutation changes anything they read, so a cached result is never stale. <b>Per user</b> queries read <code>ctx.auth</code>, so each
          signed-in user has their own entry.
        </p>
      </section>
    </div>
  );
}
