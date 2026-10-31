import { useState } from "react";
import { canWrite, formatBytes, formatDuration, get, hitRate, post, type Admin, type CacheInfo } from "../api";
import { useTelemetryOn } from "../obs";
import { Badge, Button, Empty, ErrorNote, LineChart, Segmented, Skeleton, Stat, useAction, useAsync } from "../ui";

type Bucket = { start: number; cacheHits: number | null; cacheMisses: number | null; cacheCoalesced: number | null };
type Sums = "cache_hits" | "cache_misses" | "cache_shared";
type RuntimeSeries = { series: { role?: string; points: ({ t: number } & Partial<Record<Sums, number | null>>)[] }[] };
const WINDOWS = { "1h": 3600_000, "24h": 86400_000, "7d": 7 * 86400_000 } as const;
const pct = (n: number | null) => (n === null ? "—" : `${n < 10 && n > 0 ? n.toFixed(1) : Math.round(n)}%`);

/** The servers' cache counters, from the runtime samples each one records every 10 s, summed per time bucket. */
function buckets(r: RuntimeSeries): Bucket[] {
  const servers = r.series.filter((s) => s.role === "server");
  const sum = (i: number, k: Sums) => {
    const values = servers.map((s) => s.points[i]?.[k]).filter((v): v is number => typeof v === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return (servers[0]?.points ?? []).map((p, i) => ({ start: p.t, cacheHits: sum(i, "cache_hits"), cacheMisses: sum(i, "cache_misses"), cacheCoalesced: sum(i, "cache_shared") }));
}

export function Cache({ admin }: { admin: Admin }) {
  const [window, setWindow] = useState<keyof typeof WINDOWS>("1h");
  const telemetry = useTelemetryOn();
  const cache = useAsync(() => get<CacheInfo>("cache"), [], { interval: 4000 });
  const series = useAsync(
    () => (telemetry ? get<RuntimeSeries>("obs.runtime", { from: Date.now() - WINDOWS[window], to: Date.now() }).then(buckets) : Promise.resolve([])),
    [window, telemetry],
    { interval: 15_000 },
  );
  const { run, busy } = useAction();
  const c = cache.data;
  if (cache.loading && !c) return <Skeleton rows={6} />;
  if (!c) return <ErrorNote error={cache.error} />;
  if (!c.enabled) return <Empty icon="cache">The query cache is off. Set CACHE_TTL_MS to a number of milliseconds to turn it on (the default is 60000).</Empty>;

  const rate = hitRate(c);
  const served = c.hits + c.coalesced;
  const saved = c.functions.reduce((n, f) => n + f.savedMs, 0);
  const b = series.data ?? [];
  const labels = b.map((x) => new Date(x.start).toLocaleTimeString([], window === "7d" ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" }));
  const bucketServed = (x: Bucket) => (x.cacheHits === null ? null : x.cacheHits + (x.cacheCoalesced ?? 0));
  const bucketRate = (x: Bucket) => hitRate({ hits: x.cacheHits ?? 0, coalesced: x.cacheCoalesced ?? 0, misses: x.cacheMisses ?? 0 });
  const functions = [...c.functions].sort((x, y) => y.hits + y.coalesced + y.misses - (x.hits + x.coalesced + x.misses));

  return (
    <div className="stack">
      <section className="stats" aria-label="Cache summary">
        <Stat
          label="Hit rate"
          icon="cache"
          tone={rate === null ? undefined : rate >= 50 ? "ok" : "ember"}
          value={pct(rate)}
          hint={rate === null ? "No queries yet" : `${served.toLocaleString()} of ${(served + c.misses).toLocaleString()} calls`}
          trend={b.map((x) => bucketRate(x) ?? 0)}
        />
        <Stat
          label="Served from cache"
          icon="bolt"
          value={served.toLocaleString()}
          hint={`${c.hits.toLocaleString()} hits · ${c.coalesced.toLocaleString()} shared a run`}
          trend={b.map((x) => bucketServed(x) ?? 0)}
        />
        <Stat
          label="Function runs"
          icon="functions"
          value={c.misses.toLocaleString()}
          hint={c.skipped ? `${c.skipped.toLocaleString()} results not kept (changed mid-run, too big, or per user)` : "every result was kept"}
          trend={b.map((x) => x.cacheMisses ?? 0)}
        />
        <Stat
          label="In the cache"
          icon="data"
          value={c.entries === null ? "—" : c.entries.toLocaleString()}
          hint={c.backend === "redis" ? "held in Redis" : `${formatBytes(c.bytes)} of ${formatBytes(c.maxBytes)}`}
        />
      </section>
      <section className="stats" aria-label="Cache details">
        <Stat label="Time saved" icon="scheduled" tone={saved > 0 ? "ember" : undefined} value={formatDuration(saved)} hint="estimated, at each function's average run time" />
        <Stat label="Evicted by writes" icon="flame" value={c.invalidatedEntries.toLocaleString()} hint="dropped when a mutation changed what they read" />
        <Stat
          label="Evicted for space"
          icon="settings"
          value={c.evictions.toLocaleString()}
          hint={c.backend === "redis" ? "Redis manages its own memory" : "pushed out to stay within the memory limit"}
        />
        <Stat label="Entry lifetime" icon="scheduled" value={formatDuration(c.ttlMs)} hint="at most; a write evicts sooner" />
      </section>

      <section className="panel stack" aria-label="Hits and misses over time">
        <div className="toolbar">
          <h3>Over time</h3>
          <span className="muted small">all servers, sampled every 10 s</span>
          <span className="push" />
          <Segmented label="Window" value={window} options={Object.keys(WINDOWS).map((w) => ({ value: w as keyof typeof WINDOWS, label: w }))} onChange={setWindow} />
        </div>
        {telemetry ? (
          <>
            <ErrorNote error={series.error} />
            <div className="charts">
              <LineChart
                title="Served from cache vs. run"
                labels={labels}
                series={[
                  { name: "from cache", values: b.map(bucketServed), color: "var(--ok)" },
                  { name: "function runs", values: b.map((x) => x.cacheMisses), color: "var(--ember)" },
                ]}
              />
              <LineChart title="Hit rate" unit="%" labels={labels} series={[{ name: "hit rate", values: b.map((x) => (x.cacheHits === null ? null : bucketRate(x))), color: "var(--ember)" }]} />
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
          <span className="muted small">this server, since it started</span>
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
                    Hits
                  </th>
                  <th scope="col" className="num">
                    Shared
                  </th>
                  <th scope="col" className="num">
                    Runs
                  </th>
                  <th scope="col" className="num">
                    Avg hit
                  </th>
                  <th scope="col" className="num">
                    Avg run
                  </th>
                  <th scope="col" className="num">
                    Saved
                  </th>
                </tr>
              </thead>
              <tbody>
                {functions.map((f) => {
                  const r = hitRate(f);
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
                      <td className="num">{f.hits.toLocaleString()}</td>
                      <td className="num">{f.coalesced.toLocaleString()}</td>
                      <td className="num">{f.misses.toLocaleString()}</td>
                      <td className="num muted">{f.hits ? formatDuration(f.hitMs / f.hits) : "—"}</td>
                      <td className="num muted">{f.misses ? formatDuration(f.missMs / f.misses) : "—"}</td>
                      <td className="num">{f.savedMs ? formatDuration(f.savedMs) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="cache">No queries have run yet. Call one from your app and it shows up here.</Empty>
        )}
        <p className="muted small">
          A <b>hit</b> is answered from the cache. <b>Shared</b> calls arrived while an identical call was already running and used its result. A <b>run</b> executed the function. Entries
          are evicted the moment a mutation changes anything they read, so a cached result is never stale. <b>Per user</b> queries read <code>ctx.auth</code>, so each signed-in user has
          their own entry.
        </p>
      </section>
    </div>
  );
}
