import { useState } from "react";
import { canWrite, get, post, type Admin } from "../api";
import { Icon } from "../brand";
import { count, ms, pct } from "../format";
import { Card, OpName, Refreshing } from "../kit";
import { useObs, type Operation } from "../obs";
import { Button, Drawer, Empty, ErrorNote, Field, Skeleton, useAction, useAsync } from "../ui";

type Slo = {
  id: string;
  name: string;
  service: string | null;
  operation: string | null;
  objective: "latency" | "availability";
  target: number;
  thresholdMs: number | null;
  windowDays: number;
  sli: number | null;
  requests: number;
  budgetRemaining: number | null;
  burn1h: number | null;
  burn6h: number | null;
  status: "healthy" | "at risk" | "breached" | "no data";
};

const TONE = { healthy: "ok", "at risk": "warn", breached: "bad", "no data": "neutral" } as const;
export const objectiveText = (s: Pick<Slo, "objective" | "target" | "thresholdMs">) =>
  s.objective === "latency" ? `${(s.target * 100).toFixed(s.target >= 0.999 ? 2 : 1)}% of requests under ${ms(s.thresholdMs)}` : `${(s.target * 100).toFixed(s.target >= 0.999 ? 2 : 1)}% of requests without server errors`;

export function Slos({ admin }: { admin: Admin }) {
  const slos = useObs<Slo[]>("slos", {}, { range: false });
  const [editing, setEditing] = useState<Partial<Slo> | null>(null);
  const { run, busy } = useAction();
  const write = canWrite(admin);
  if (slos.loading && !slos.data) return <Skeleton rows={6} />;
  return (
    <div className="obs-page">
      <ErrorNote error={slos.error} />
      <div className="toolbar-row">
        <span className="muted small">An SLO is a promise over traffic you already record: its error budget is how much of the window may miss it, and the burn rate is how fast that budget is going.</span>
        <span className="push" />
        {write && (
          <Button onClick={() => setEditing({ objective: "latency", target: 0.99, thresholdMs: 500, windowDays: 28 })}>
            <Icon name="plus" size={15} /> New SLO
          </Button>
        )}
      </div>
      <Card className="flush" title={<>Objectives <span className="badge">{slos.data?.length ?? 0}</span> <Refreshing on={slos.refreshing} /></>}>
        {slos.data?.length ? (
          <table className="obs-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Objective</th>
                <th scope="col">Budget left</th>
                <th scope="col" className="num">
                  Burn (1h)
                </th>
                <th scope="col">Status</th>
                {write && <th scope="col" />}
              </tr>
            </thead>
            <tbody>
              {slos.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    <div className="faint small">{s.operation ? <OpName operation={s.operation} /> : "all operations"}{s.service ? ` · ${s.service}` : ""}</div>
                  </td>
                  <td>
                    {objectiveText(s)}
                    <div className="faint small">rolling {s.windowDays} days · {count(s.requests)} requests</div>
                  </td>
                  <td>
                    {s.budgetRemaining === null ? (
                      <span className="faint">—</span>
                    ) : (
                      <span className={`budget ${TONE[s.status]}`}>
                        <span className="budget-track">
                          <i style={{ width: `${Math.max(0, Math.min(1, s.budgetRemaining)) * 100}%` }} />
                        </span>
                        <b>{pct(Math.max(-9.99, s.budgetRemaining))}</b>
                        <span className="faint small">SLI {s.sli === null ? "—" : `${(s.sli * 100).toFixed(3)}%`}</span>
                      </span>
                    )}
                  </td>
                  <td className={`num mono${(s.burn1h ?? 0) >= 2 ? " bad" : ""}`}>{s.burn1h === null ? "—" : `${s.burn1h.toFixed(2)}×`}</td>
                  <td>
                    <span className={`badge ${TONE[s.status]}`}>{s.status}</span>
                  </td>
                  {write && (
                    <td className="num nowrap">
                      <Button variant="ghost" className="icon-only" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                        <Icon name="edit" size={14} />
                      </Button>
                      <Button variant="ghost" className="icon-only" aria-label={`Delete ${s.name}`} disabled={busy} onClick={() => confirm(`Delete the SLO "${s.name}"? Alert rules on its burn rate are deleted with it.`) && run(() => post("obs.deleteSlo", { id: s.id }), "SLO deleted").then(slos.reload)}>
                        <Icon name="trash" size={14} />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon="slo">No SLOs yet. {write ? "Start with one for your most important operation: 99% under some latency, or 99.9% without errors." : "An admin can add them."}</Empty>
        )}
      </Card>
      {editing && (
        <SloForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            slos.reload();
          }}
        />
      )}
    </div>
  );
}

function SloForm({ initial, onClose, onSaved }: { initial: Partial<Slo>; onClose: () => void; onSaved: () => void }) {
  const [objective, setObjective] = useState(initial.objective ?? "latency");
  const ops = useAsync(() => get<{ operations: Operation[] }>("obs.requests", { from: Date.now() - 7 * 86_400_000, to: Date.now() }), []);
  const { run, busy } = useAction();
  return (
    <Drawer title={initial.id ? `Edit ${initial.name}` : "New SLO"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const input = {
            id: initial.id,
            name: String(f.get("name")),
            operation: String(f.get("operation") ?? "") || null,
            service: String(f.get("service") ?? "") || null,
            objective,
            target: Number(f.get("target")) / 100,
            thresholdMs: objective === "latency" ? Number(f.get("threshold")) : null,
            windowDays: Number(f.get("window")),
          };
          void run(() => post("obs.saveSlo", input), initial.id ? "SLO updated" : "SLO created").then((r) => r.ok && onSaved());
        }}
      >
        <Field label="Name">{(id) => <input id={id} name="name" defaultValue={initial.name} placeholder="Checkout latency" required autoFocus />}</Field>
        <div className="segmented" role="radiogroup" aria-label="Objective">
          <button type="button" aria-pressed={objective === "latency"} onClick={() => setObjective("latency")}>
            Latency
          </button>
          <button type="button" aria-pressed={objective === "availability"} onClick={() => setObjective("availability")}>
            Availability
          </button>
        </div>
        <div className="grid-form">
          <Field label="Target (%)" hint="Share of requests that must meet it">
            {(id) => <input id={id} name="target" type="number" min="50" max="99.999" step="0.001" defaultValue={((initial.target ?? 0.99) * 100).toString()} required />}
          </Field>
          {objective === "latency" && <Field label="Under (ms)">{(id) => <input id={id} name="threshold" type="number" min="1" step="1" defaultValue={initial.thresholdMs ?? 500} required />}</Field>}
          <Field label="Window">
            {(id) => (
              <select id={id} name="window" defaultValue={String(initial.windowDays ?? 28)}>
                {[7, 14, 28, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    rolling {d} days
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label="Operation" hint="Leave empty for every request">
          {(id) => (
            <>
              <input id={id} name="operation" list={`${id}-ops`} defaultValue={initial.operation ?? ""} placeholder="todos:list or GET /users/:id" />
              <datalist id={`${id}-ops`}>
                {ops.data?.operations.map((o) => (
                  <option key={o.kind + o.operation} value={o.operation} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Service" hint="Leave empty for all of them">{(id) => <input id={id} name="service" defaultValue={initial.service ?? ""} />}</Field>
        <Button type="submit" disabled={busy}>
          <Icon name="check" size={15} /> {initial.id ? "Update SLO" : "Create SLO"}
        </Button>
      </form>
    </Drawer>
  );
}
