import { Fragment, useState } from "react";
import { Icon } from "../brand";
import { Treemap } from "../charts";
import { count, ms, pct } from "../format";
import { Card, Refreshing, spanHref, useSort } from "../kit";
import { useObs } from "../obs";
import { Empty, ErrorNote, Skeleton } from "../ui";
import { TYPE_LABEL } from "./Spans";
import { typeColor } from "./Trace";

/** A class keeps its color whatever the order: from its name, not its rank. */
const hue = (name: string) => ([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6) + 1;

type Method = { name: string; self: number; total: number; count: number; errors: number };
type Hot = { namespace: string; type: string; self: number; share: number; avgSelf: number; total: number; count: number; errors: number; methods: Method[] };

/**
 * Where the time goes, by its own time: every module, class and dependency, or (`nest`, the Services page) only the app's Nest classes, as
 * the time each controller, provider, gateway and router spends in its own code.
 */
export function Hotspots({ nest = false }: { nest?: boolean }) {
  const h = useObs<{ total: number; list: Hot[] }>("hotspots", nest ? { type: "nest" } : {});
  const [open, setOpen] = useState<string | null>(null);
  const { th, apply } = useSort<"self" | "avgSelf" | "total" | "count" | "errors">("self");
  if (h.loading && !h.data) return <Skeleton rows={8} />;
  if (!h.data) return <ErrorNote error={h.error} />;
  const d = { ...h.data, list: apply(h.data.list, (x, k) => x[k]) };
  if (!d.list.length)
    return nest ? (
      <Empty icon="box">
        No Nest class ran in this range. Classes decorated with <code>@Controller()</code>, <code>@Injectable()</code>, <code>@WebSocketGateway()</code> or <code>@Router()</code> from{" "}
        <code>@archlast/forge-runtime/nest</code> are timed method by method, and show here once requests run them.
      </Empty>
    ) : (
      <Empty icon="hotspots">Nothing has run yet in this range. Once requests run code, this shows which modules, classes and dependencies the time goes to.</Empty>
    );
  // The map is by own time whatever the table is sorted by; the server sends the list in that order.
  const top = h.data.list.slice(0, 14);
  const rest = h.data.list.slice(14).reduce((s, x) => s + x.self, 0);
  return (
    <div className="obs-page">
      <Card title={<>Where the time goes <Refreshing on={h.refreshing} /></>} extra={<span className="note-line">own time · {ms(d.total)} in all</span>}>
        <Treemap
          height={260}
          tiles={[
            ...top.map((x) => ({ id: `${x.type}\u0000${x.namespace}`, label: `${x.namespace}`, sub: nest ? ms(x.self) : `${x.type} · ${ms(x.self)}`, value: x.self, color: nest ? `var(--viz-${hue(x.namespace)})` : typeColor(x.type) })),
            ...(rest > 0 ? [{ id: "rest", label: `${d.list.length - 14} more`, value: rest, color: "var(--viz-quiet)" }] : []),
          ]}
          onPick={(id) => setOpen(id)}
        />
      </Card>
      <Card
        className="flush"
        footer={
          <span>
            {nest
              ? "Own time is the time a class spends in its own code, with what it awaited further down subtracted: where the time actually goes. Total time includes everything awaited below, so a controller can top it while doing no work of its own. Past TELEMETRY_DETAIL_PER_SECOND the milliseconds are estimates; shares and order hold."
              : "Own time is the time spent in a module's, class's or dependency's own code, with what it waited on further down subtracted: where the time actually goes. Total time includes everything awaited below, so a controller can top it while doing nothing itself."}
          </span>
        }
      >
        <table className="obs-table">
          <thead>
            <tr>
              <th scope="col">{nest ? "Class" : "Code"}</th>
              {th("self", "Own time")}
              {th("avgSelf", "Avg own / call", "num")}
              {th("total", "Total time", "num")}
              {th("count", "Calls", "num")}
              {th("errors", "Errors", "num")}
              <th scope="col" className="num">
                Methods
              </th>
            </tr>
          </thead>
          <tbody>
            {d.list.map((x) => {
              const id = `${x.type}\u0000${x.namespace}`;
              return (
                <Fragment key={id}>
                  <tr className="clickable" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>
                    <td>
                      <span className="op-name">
                        <Icon name={open === id ? "chevron-down" : "chevron-right"} size={12} />
                        {!nest && (
                          <span className="wf-type" style={{ "--c": typeColor(x.type) } as React.CSSProperties}>
                            {TYPE_LABEL[x.type] ?? x.type}
                          </span>
                        )}
                        <code>{x.namespace}</code>
                      </span>
                    </td>
                    <td>
                      <span className="share">
                        <i style={{ width: `${x.share * 100}%` }} />
                        <b>
                          {ms(x.self)} · {pct(x.share)}
                        </b>
                      </span>
                    </td>
                    <td className="num mono">{ms(x.avgSelf)}</td>
                    <td className="num mono">{ms(x.total)}</td>
                    <td className="num mono">{count(x.count)}</td>
                    <td className={`num mono${x.errors ? " bad" : ""}`}>{count(x.errors)}</td>
                    <td className="num mono">{x.methods.length}</td>
                  </tr>
                  {open === id &&
                    x.methods.map((m) => (
                      <tr key={m.name} className="sub-row clickable" onClick={() => (location.hash = spanHref(x.type, m.name))}>
                        <td>
                          <code className="sub-name">{m.name}</code>
                        </td>
                        <td>
                          <span className="share">
                            <i style={{ width: `${(m.self / Math.max(x.self, 0.001)) * 100}%` }} />
                            <b>{ms(m.self)}</b>
                          </span>
                        </td>
                        <td className="num mono">{ms(m.self / Math.max(1, m.count))}</td>
                        <td className="num mono">{ms(m.total)}</td>
                        <td className="num mono">{count(m.count)}</td>
                        <td className={`num mono${m.errors ? " bad" : ""}`}>{count(m.errors)}</td>
                        <td />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
