import { useMemo, useState } from "react";
import { get, type Admin, type Doc } from "../api";
import { Icon } from "../brand";
import { RangeBar, RateBar, Scatter, TimeChart } from "../charts";
import { ago, count, fullTime, ms, pct } from "../format";
import { BackLink, Card, Chips, Delta, errorHref, Facts, Headline, OpName, Refreshing, SearchBox, StatusTag, TelemetryOff, usePages, useSort } from "../kit";
import { useObs, useTelemetryOn } from "../obs";
import { href, navigate } from "../router";
import { Badge, Button, Empty, ErrorNote, Segmented, Skeleton, useAsync } from "../ui";
import { Accounts, UserDrawer, type User } from "./Users";

type UserRow = { id: string; name: string | null; count: number; errors: number; failureRate: number; avg: number; p95: number; last: number };
type UsersData = {
  total: number;
  previous: number;
  step: number;
  series: { t: number; count: number }[];
  list: UserRow[];
  domains: { domain: string; users: number; count: number; errors: number }[];
};

export function UsersPage({ params, admin }: { params: URLSearchParams; admin: Admin }) {
  const id = params.get("id");
  const telemetry = useTelemetryOn();
  const [tab, setTab] = useState<"activity" | "accounts">(params.get("tab") === "accounts" || !telemetry ? "accounts" : "activity");
  if (id) return telemetry ? <UserDetail userId={id} admin={admin} /> : <TelemetryOff />;
  return (
    <div className="obs-page">
      <div className="toolbar-row">
        <Segmented
          label="View"
          value={tab}
          onChange={setTab}
          options={[
            { value: "activity", label: "Activity" },
            { value: "accounts", label: "Accounts" },
          ]}
        />
      </div>
      {tab === "accounts" ? <Accounts admin={admin} /> : telemetry ? <Activity /> : <TelemetryOff />}
    </div>
  );
}

function Activity() {
  const [search, setSearch] = useState("");
  const [byDomain, setByDomain] = useState<"people" | "customers">("people");
  const u = useObs<UsersData>("users", { search: search || undefined });
  const { th, apply } = useSort<"name" | "p95" | "failureRate" | "count" | "last">("count");
  if (u.loading && !u.data) return <Skeleton rows={8} />;
  if (!u.data) return <ErrorNote error={u.error} />;
  const d = u.data;
  const rows = apply(d.list, (r, k) => (k === "name" ? (r.name ?? r.id) : r[k]));
  const maxP95 = Math.max(1, ...rows.map((r) => r.p95));
  return (
    <>
      <div className="grid-2">
        <Card
          title={
            <>
              Active users <Refreshing on={u.refreshing} />
            </>
          }
        >
          <Headline value={d.total} sub={<Delta now={d.total} before={d.previous} upIsGood />} />
          <TimeChart
            points={d.series}
            step={d.step}
            height={140}
            marks={[{ kind: "bars", stack: [{ key: "count", label: "active users", color: "var(--viz-2)" }] }]}
            emptyLabel="No signed-in requests in this range"
          />
        </Card>
        <Card title="Latency by user">
          {d.list.length ? (
            <Scatter
              points={d.list.slice(0, 200).map((r) => ({ id: r.id, label: r.name ?? r.id, x: r.count, y: r.p95, rate: r.failureRate }))}
              xLabel="requests"
              yLabel="p95"
              onPick={(id) => navigate("users", { id })}
            />
          ) : (
            <Empty icon="users">Requests from signed-in users show up here.</Empty>
          )}
        </Card>
      </div>
      <div className="toolbar-row">
        <Chips
          label="Group"
          value={byDomain}
          onChange={setByDomain}
          options={[
            { value: "people", label: "People", count: d.list.length },
            { value: "customers", label: "Customers by email domain", count: d.domains.length },
          ]}
        />
        <span className="push" />
        <SearchBox value={search} onChange={setSearch} placeholder="Find a user…" />
      </div>
      <Card className="flush" footer={<span>From kept traces: with sampling on, counts are estimates (each kept request stands for the ones like it that weren't).</span>}>
        {byDomain === "customers" ? <Domains domains={d.domains} /> : <UserTable rows={rows} th={th} maxP95={maxP95} />}
      </Card>
    </>
  );
}

function UserTable({ rows, th, maxP95 }: { rows: UserRow[]; th: ReturnType<typeof useSort<any>>["th"]; maxP95: number }) {
  const { rows: page, pager } = usePages(rows, 20);
  if (!rows.length) return <Empty icon="users">No signed-in users made requests in this range.</Empty>;
  return (
    <>
      <div className="table-scroll">
        <table className="obs-table">
          <thead>
            <tr>
              {th("name", "User")}
              {th("p95", "Duration")}
              {th("failureRate", "Failure rate")}
              {th("count", "Requests", "num")}
              {th("last", "Last seen", "num")}
            </tr>
          </thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate("users", { id: r.id })}>
                <td>
                  <span className="user-cell">
                    <span className="avatar small" aria-hidden="true">
                      {(r.name ?? r.id).slice(0, 2).toUpperCase()}
                    </span>
                    <span>
                      {r.name ?? r.id}
                      {r.name && <div className="faint mono small">{r.id}</div>}
                    </span>
                  </span>
                </td>
                <td>
                  <RangeBar avg={r.avg} p95={r.p95} max={maxP95} />
                </td>
                <td>
                  <RateBar rate={r.failureRate} />
                </td>
                <td className="num mono">{count(r.count)}</td>
                <td className="num muted small">{ago(r.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

function Domains({ domains }: { domains: UsersData["domains"] }) {
  if (!domains.length) return <Empty icon="users">No email addresses to group by.</Empty>;
  return (
    <table className="obs-table">
      <thead>
        <tr>
          <th scope="col">Customer</th>
          <th scope="col" className="num">
            People
          </th>
          <th scope="col">Failure rate</th>
          <th scope="col" className="num">
            Requests
          </th>
        </tr>
      </thead>
      <tbody>
        {domains.map((d) => (
          <tr key={d.domain}>
            <td className="mono">{d.domain}</td>
            <td className="num mono">{d.users}</td>
            <td>
              <RateBar rate={d.count ? d.errors / d.count : 0} />
            </td>
            <td className="num mono">{count(d.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type UserData = {
  userId: string;
  name: string | null;
  count: number;
  errors: number;
  failureRate: number;
  avg: number;
  p95: number;
  lastSeen: number | null;
  calls: {
    trace_id: string;
    time: number;
    duration: number;
    kind: string;
    operation: string;
    method: string | null;
    status: number;
    error_message: string | null;
    error_group: string | null;
    cache: string | null;
  }[];
  errorGroups: { fingerprint: string; count: number; last: number; type?: string; message?: string }[];
};

/** Calls close together in time, as the actions a person took: one click can be several requests. */
function actions(calls: UserData["calls"], gapMs: number) {
  const sorted = [...calls].sort((a, b) => Number(a.time) - Number(b.time));
  const out: { start: number; end: number; calls: UserData["calls"] }[] = [];
  for (const c of sorted) {
    const last = out.at(-1);
    if (last && Number(c.time) - last.end <= gapMs) {
      last.calls.push(c);
      last.end = Math.max(last.end, Number(c.time) + Number(c.duration));
    } else out.push({ start: Number(c.time), end: Number(c.time) + Number(c.duration), calls: [c] });
  }
  return out.reverse();
}

function UserDetail({ userId, admin }: { userId: string; admin: Admin }) {
  const u = useObs<UserData>("user", { userId });
  const [gap, setGap] = useState<"5000" | "30000" | "120000" | "600000">("30000");
  const account = useAsync(
    () => (userId.startsWith("users:") ? get<Record<string, Doc | null>>("docsByIds", { ids: [userId] }).then((r) => r[userId] as User | null) : Promise.resolve(null)),
    [userId],
  );
  const [drawer, setDrawer] = useState(false);
  const groups = useMemo(() => actions(u.data?.calls ?? [], Number(gap)), [u.data, gap]);
  const { rows: page, pager } = usePages(groups, 25);
  if (u.loading && !u.data) return <Skeleton rows={8} />;
  if (!u.data) return <ErrorNote error={u.error} />;
  const d = u.data;
  const acct = account.data;
  const maxDur = Math.max(1, ...groups.map((g) => g.end - g.start));
  return (
    <div className="obs-page">
      <BackLink to={href("users")}>All users</BackLink>
      <Card
        title={
          <span className="user-cell">
            <span className="avatar" aria-hidden="true">
              {(acct?.email ?? d.name ?? userId).slice(0, 2).toUpperCase()}
            </span>
            <span>
              {acct?.email ?? d.name ?? userId}
              <div className="faint mono small">{userId}</div>
            </span>
          </span>
        }
        className="flush"
        extra={
          acct && (
            <>
              {acct.banned ? <Badge tone="bad">banned</Badge> : acct.emailVerified ? <Badge tone="ok">verified</Badge> : <Badge>unverified</Badge>}
              <Button variant="ghost" onClick={() => setDrawer(true)}>
                <Icon name="key" size={14} /> Account & sessions
              </Button>
            </>
          )
        }
      >
        <Facts
          items={[
            ...(acct
              ? [
                  { label: "Name", value: acct.name || "—" },
                  { label: "Joined", value: fullTime(acct._creationTime) },
                ]
              : []),
            { label: "Requests", value: count(d.count) },
            { label: "Errors", value: count(d.errors), tone: d.errors ? ("bad" as const) : undefined },
            { label: "Failure rate", value: pct(d.failureRate) },
            { label: "Avg · p95", value: `${ms(d.avg)} · ${ms(d.p95)}` },
            { label: "Last seen", value: ago(d.lastSeen) },
          ]}
        />
      </Card>
      {d.errorGroups.length > 0 && (
        <Card
          title={
            <>
              Errors this user hit <span className="badge">{d.errorGroups.length}</span>
            </>
          }
        >
          <ul className="ranked">
            {d.errorGroups.map((e) => (
              <li key={e.fingerprint}>
                <a className="plain-link" href={errorHref(e.fingerprint)}>
                  <strong>{e.type}</strong> <span className="mono small">{e.message}</span>
                </a>
                <span className="rk-value bad">{count(e.count)}×</span>
                <span className="rk-sub">{ago(e.last)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card
        title={
          <>
            Actions <span className="badge">{groups.length}</span>
          </>
        }
        className="flush"
        extra={
          <>
            <span className="note-line">group calls within</span>
            <Segmented
              label="Group within"
              value={gap}
              onChange={setGap}
              options={[
                { value: "5000", label: "5s" },
                { value: "30000", label: "30s" },
                { value: "120000", label: "2m" },
                { value: "600000", label: "10m" },
              ]}
            />
          </>
        }
      >
        {groups.length ? (
          <ol className="timeline">
            {page.map((g, i) => {
              const failed = g.calls.filter((c) => Number(c.status) >= 400).length;
              const ops = [...new Set(g.calls.map((c) => c.operation))];
              return (
                <li key={g.start + ":" + i} className={failed ? "failed" : undefined}>
                  <span className="tl-time" title={fullTime(g.start)}>
                    {new Date(g.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="tl-body">
                    <span className="tl-ops">
                      {ops.slice(0, 2).map((op) => (
                        <OpName key={op} operation={op} kind={g.calls.find((c) => c.operation === op)!.kind} />
                      ))}
                      {ops.length > 2 && <span className="faint small">+{ops.length - 2} more</span>}
                    </span>
                    <span className="tl-bar">
                      <i style={{ width: `${Math.max(1, ((g.end - g.start) / maxDur) * 100)}%` }} className={failed ? "bad" : undefined} />
                    </span>
                  </span>
                  <span className="tl-meta">
                    {ms(g.end - g.start)} · {g.calls.length} call
                    {g.calls.length === 1 ? "" : "s"}
                    {failed > 0 && <StatusTag status={Math.max(...g.calls.map((c) => Number(c.status)))} />}
                  </span>
                  <a className="trace-link" href={href("trace", { id: g.calls[0]!.trace_id })} aria-label="Open the first trace">
                    <Icon name="arrow" size={14} />
                  </a>
                </li>
              );
            })}
          </ol>
        ) : (
          <Empty icon="users">No requests from this user in this range.</Empty>
        )}
        {pager}
      </Card>
      {drawer && acct && <UserDrawer user={acct} admin={admin} onClose={() => setDrawer(false)} onChanged={account.reload} />}
    </div>
  );
}
