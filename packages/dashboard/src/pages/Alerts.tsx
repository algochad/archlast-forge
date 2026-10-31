import { useState } from "react";
import { canWrite, get, post, type Admin } from "../api";
import { Icon } from "../brand";
import { ago, fullTime, ms } from "../format";
import { Card, Refreshing } from "../kit";
import { useObs, type Operation } from "../obs";
import { Badge, Button, Drawer, Empty, ErrorNote, Field, Skeleton, useAction, useAsync } from "../ui";

type Rule = {
  id: string;
  name: string;
  metric: "error_rate" | "failure_rate" | "p95" | "avg" | "requests" | "slo_burn";
  service: string | null;
  operation: string | null;
  comparator: ">" | "<";
  threshold: number;
  window_min: number;
  webhook: string | null;
  enabled: number;
  state: "ok" | "firing";
  since: number | null;
  value: number | null;
  evaluated_at: number | null;
};
type Event = { id: string; rule_id: string; rule_name: string; time: number; state: string; value: number | null; message: string; delivery: string | null; seen: number };

const METRICS: Record<Rule["metric"], { label: string; unit: string }> = {
  error_rate: { label: "Server error rate", unit: "%" },
  failure_rate: { label: "Failure rate (4xx and 5xx)", unit: "%" },
  p95: { label: "p95 latency", unit: "ms" },
  avg: { label: "Average latency", unit: "ms" },
  requests: { label: "Requests", unit: "" },
  slo_burn: { label: "SLO burn rate", unit: "×" },
};

const shown = (rule: Pick<Rule, "metric">, v: number | null) => (v === null ? "no data" : rule.metric === "p95" || rule.metric === "avg" ? ms(v) : rule.metric.endsWith("rate") ? `${Number(v).toFixed(2)}%` : rule.metric === "slo_burn" ? `${Number(v).toFixed(2)}×` : String(Math.round(v)));

export function Alerts({ admin }: { admin: Admin }) {
  const rules = useObs<Rule[]>("alertRules", {}, { range: false });
  const events = useObs<Event[]>("alertEvents", { limit: 100 }, { range: false });
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const { run, busy } = useAction();
  const write = canWrite(admin);
  if (rules.loading && !rules.data) return <Skeleton rows={6} />;
  return (
    <div className="obs-page">
      <ErrorNote error={rules.error ?? events.error} />
      <div className="toolbar-row">
        <span className="muted small">Rules are checked every minute against the rollups. When one starts or stops holding, it posts to its webhook (Slack-compatible JSON) and to the bell above.</span>
        <span className="push" />
        {write && (
          <Button onClick={() => setEditing({ metric: "error_rate", comparator: ">", threshold: 5, window_min: 5 })}>
            <Icon name="plus" size={15} /> New rule
          </Button>
        )}
      </div>
      <Card className="flush" title={<>Rules <span className="badge">{rules.data?.length ?? 0}</span> <Refreshing on={rules.refreshing} /></>}>
        {rules.data?.length ? (
          <table className="obs-table">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Condition</th>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  Now
                </th>
                <th scope="col">Delivery</th>
                {write && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id} className={r.state === "firing" ? "firing-row" : undefined}>
                  <td>
                    <strong>{r.name}</strong>
                    {!Number(r.enabled) && <Badge>off</Badge>}
                    <div className="faint small">{r.metric === "slo_burn" ? "an SLO" : r.operation ?? "all operations"}{r.service ? ` · ${r.service}` : ""}</div>
                  </td>
                  <td className="mono small">
                    {METRICS[r.metric].label} {r.comparator} {r.threshold}
                    {METRICS[r.metric].unit} over {r.window_min} min
                  </td>
                  <td>{r.state === "firing" ? <Badge tone="bad">firing · {ago(r.since)}</Badge> : <Badge tone="ok">ok</Badge>}</td>
                  <td className="num mono" title={r.evaluated_at ? `checked ${fullTime(Number(r.evaluated_at))}` : "not checked yet"}>
                    {shown(r, r.value === null ? null : Number(r.value))}
                  </td>
                  <td className="small">{r.webhook ? <span title={r.webhook}>webhook</span> : <span className="faint">dashboard only</span>}</td>
                  {write && (
                    <td className="num nowrap">
                      <Button variant="ghost" className="icon-only" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                        <Icon name="edit" size={14} />
                      </Button>
                      <Button variant="ghost" className="icon-only" aria-label={`Delete ${r.name}`} disabled={busy} onClick={() => confirm(`Delete the rule "${r.name}"?`) && run(() => post("obs.deleteAlertRule", { id: r.id }), "Rule deleted").then(rules.reload)}>
                        <Icon name="trash" size={14} />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon="alerts">No rules yet.{write ? " A good first one: server error rate above 5% over 5 minutes." : ""}</Empty>
        )}
      </Card>
      <Card className="flush" title="History">
        {events.data?.length ? (
          <table className="obs-table">
            <tbody>
              {events.data.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Badge tone={e.state === "firing" ? "bad" : "ok"}>{e.state}</Badge>
                  </td>
                  <td>{e.message}</td>
                  <td className="small">{e.delivery ? <span className={e.delivery.startsWith("failed") ? "bad" : "muted"}>{e.delivery}</span> : <span className="faint">—</span>}</td>
                  <td className="num muted small" title={fullTime(Number(e.time))}>
                    {ago(Number(e.time))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-inline">Nothing has fired yet.</p>
        )}
      </Card>
      {editing && (
        <RuleForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            rules.reload();
          }}
        />
      )}
    </div>
  );
}

function RuleForm({ initial, onClose, onSaved }: { initial: Partial<Rule>; onClose: () => void; onSaved: () => void }) {
  const [metric, setMetric] = useState<Rule["metric"]>(initial.metric ?? "error_rate");
  const [webhook, setWebhook] = useState(initial.webhook ?? "");
  const ops = useAsync(() => get<{ operations: Operation[] }>("obs.requests", { from: Date.now() - 7 * 86_400_000, to: Date.now() }), []);
  const slos = useAsync(() => get<{ id: string; name: string }[]>("obs.slos"), []);
  const { run, busy } = useAction();
  return (
    <Drawer title={initial.id ? `Edit ${initial.name}` : "New alert rule"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const input = {
            id: initial.id,
            name: String(f.get("name")),
            metric,
            comparator: String(f.get("comparator")),
            threshold: Number(f.get("threshold")),
            windowMin: Number(f.get("window")),
            operation: String(f.get("operation") ?? "") || null,
            service: String(f.get("service") ?? "") || null,
            webhook: webhook || null,
            enabled: f.get("enabled") === "on",
          };
          void run(() => post("obs.saveAlertRule", input), initial.id ? "Rule updated" : "Rule created").then((r) => r.ok && onSaved());
        }}
      >
        <Field label="Name">{(id) => <input id={id} name="name" defaultValue={initial.name} placeholder="Checkout errors" required autoFocus />}</Field>
        <Field label="When">
          {(id) => (
            <select id={id} value={metric} onChange={(e) => setMetric(e.target.value as Rule["metric"])}>
              {Object.entries(METRICS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="grid-form">
          <Field label="Is">
            {(id) => (
              <select id={id} name="comparator" defaultValue={initial.comparator ?? ">"}>
                <option value=">">above</option>
                <option value="<">below</option>
              </select>
            )}
          </Field>
          <Field label={`Threshold${METRICS[metric].unit ? ` (${METRICS[metric].unit})` : ""}`}>{(id) => <input id={id} name="threshold" type="number" step="any" defaultValue={initial.threshold ?? 5} required />}</Field>
          <Field label="Over">
            {(id) => (
              <select id={id} name="window" defaultValue={String(initial.window_min ?? 5)}>
                {[1, 5, 10, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {metric === "slo_burn" ? (
          <Field label="SLO">
            {(id) => (
              <select id={id} name="operation" defaultValue={initial.operation ?? ""} required>
                <option value="">Pick an SLO</option>
                {slos.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <Field label="Operation" hint="Leave empty for every request">
            {(id) => (
              <>
                <input id={id} name="operation" list={`${id}-ops`} defaultValue={initial.operation ?? ""} placeholder="todos:list" />
                <datalist id={`${id}-ops`}>
                  {ops.data?.operations.map((o) => (
                    <option key={o.kind + o.operation} value={o.operation} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        )}
        <Field label="Service" hint="Leave empty for all">{(id) => <input id={id} name="service" defaultValue={initial.service ?? ""} />}</Field>
        <Field label="Webhook" hint="Gets JSON with a text field (Slack and Discord incoming webhooks read it as is)">
          {(id) => <input id={id} type="url" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/…" />}
        </Field>
        {webhook && (
          <Button variant="ghost" disabled={busy} onClick={() => run(() => post<string>("obs.testAlert", { webhook }).then((r) => {
            if (r !== "delivered") throw new Error(`Test notification ${r}`);
          }), "Test notification delivered")}>
            Send a test
          </Button>
        )}
        <label className="check-inline">
          <input type="checkbox" name="enabled" defaultChecked={initial.enabled === undefined || Boolean(Number(initial.enabled))} /> Enabled
        </label>
        <Button type="submit" disabled={busy}>
          <Icon name="check" size={15} /> {initial.id ? "Update rule" : "Create rule"}
        </Button>
      </form>
    </Drawer>
  );
}
