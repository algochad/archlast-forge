import { Fragment, useState } from "react";
import { Icon } from "../brand";
import { Treemap } from "../charts";
import { count, ms, pct } from "../format";
import { Card, Refreshing, spanHref } from "../kit";
import { useObs } from "../obs";
import { Empty, ErrorNote, Skeleton } from "../ui";
import { TYPE_LABEL } from "./Spans";
import { typeColor } from "./Trace";

type Method = { name: string; self: number; total: number; count: number; errors: number };
type Hot = { namespace: string; type: string; self: number; share: number; avgSelf: number; total: number; count: number; errors: number; methods: Method[] };

export function Hotspots() {
  const h = useObs<{ total: number; list: Hot[] }>("hotspots");
  const [open, setOpen] = useState<string | null>(null);
  if (h.loading && !h.data) return <Skeleton rows={8} />;
  if (!h.data) return <ErrorNote error={h.error} />;
  const d = h.data;
  if (!d.list.length) return <Empty icon="hotspots">Nothing has run yet in this range. Once requests run code, this shows which modules, classes and dependencies the time goes to.</Empty>;
  const top = d.list.slice(0, 14);
  const rest = d.list.slice(14).reduce((s, x) => s + x.self, 0);
  return (
    <div className="obs-page">
      <Card title={<>Where the time goes <Refreshing on={h.refreshing} /></>} extra={<span className="note-line">own time · {ms(d.total)} in all</span>}>
        <Treemap
          height={260}
          tiles={[
            ...top.map((x) => ({ id: `${x.type}\u0000${x.namespace}`, label: `${x.namespace}`, sub: `${x.type} · ${ms(x.self)}`, value: x.self, color: typeColor(x.type) })),
            ...(rest > 0 ? [{ id: "rest", label: `${d.list.length - 14} more`, value: rest, color: "var(--viz-quiet)" }] : []),
          ]}
          onPick={(id) => setOpen(id)}
        />
      </Card>
      <Card
        className="flush"
        footer={
          <span>
            Own time is the time spent in a module's, class's or dependency's own code, with what it waited on further down subtracted: where the time actually goes. Total time includes everything awaited below, so a controller can top it while doing nothing
            itself.
          </span>
        }
      >
        <table className="obs-table">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Own time</th>
              <th scope="col" className="num">
                Avg own / call
              </th>
              <th scope="col" className="num">
                Total time
              </th>
              <th scope="col" className="num">
                Calls
              </th>
              <th scope="col" className="num">
                Errors
              </th>
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
                        <span className="wf-type" style={{ "--c": typeColor(x.type) } as React.CSSProperties}>
                          {TYPE_LABEL[x.type] ?? x.type}
                        </span>
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
