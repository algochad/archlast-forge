import { useState } from "react";
import { ago, canWrite, get, post, type Admin } from "../api";
import { Badge, Button, Empty, ErrorNote, Field, useAction, useAsync } from "../ui";

type Job = { _id: string; name: string; args: string; scheduledTime: number; state: string; error: string | null; completedTime: number | null };
type Cron = { name: string; fn: string; schedule: { kind: string; ms?: number; expression?: string }; next: number };

const tone = (state: string) => (state === "success" ? "ok" : state === "failed" ? "bad" : state === "running" ? "accent" : state === "pending" ? "warn" : "neutral");
const every = (ms: number) => (ms % 3600_000 === 0 ? `${ms / 3600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`);

export function Scheduled({ admin }: { admin: Admin }) {
  const [state, setState] = useState("");
  const crons = useAsync(() => get<Cron[]>("crons"), [], { interval: 30_000 });
  const jobs = useAsync(() => get<Job[]>("scheduled", { state: state || undefined, limit: 200 }), [state], { interval: 3000 });
  const { run, busy } = useAction();
  return (
    <div className="stack">
      <section className="panel" aria-label="Crons">
        <h3>Crons</h3>
        {crons.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">name</th>
                  <th scope="col">function</th>
                  <th scope="col">schedule</th>
                  <th scope="col">next run</th>
                </tr>
              </thead>
              <tbody>
                {crons.data.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>
                      <code>{c.fn}</code>
                    </td>
                    <td className="muted">{c.schedule.kind === "interval" ? `every ${every(c.schedule.ms!)}` : `${c.schedule.expression} (UTC)`}</td>
                    <td>{new Date(c.next).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="scheduled">No crons (convex/crons.ts).</Empty>
        )}
      </section>
      <section className="panel stack" aria-label="Scheduled jobs">
        <div className="toolbar">
          <h3>Jobs</h3>
          <Field label="State">
            {(id) => (
              <select id={id} value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">all</option>
                {["pending", "running", "success", "failed", "canceled"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <ErrorNote error={jobs.error} />
        {jobs.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">scheduled for</th>
                  <th scope="col">function</th>
                  <th scope="col">args</th>
                  <th scope="col">state</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((j) => (
                  <tr key={j._id}>
                    <td className="nowrap">
                      {new Date(j.scheduledTime).toLocaleString()} <span className="muted small">({ago(j.scheduledTime)})</span>
                    </td>
                    <td>{j.name}</td>
                    <td>
                      <code className="cell-code">{j.args}</code>
                    </td>
                    <td>
                      <Badge tone={tone(j.state)}>{j.state}</Badge> {j.error && <span className="bad small">{j.error}</span>}
                    </td>
                    <td className="nowrap">
                      {canWrite(admin) && j.state === "pending" && (
                        <Button variant="ghost" disabled={busy} onClick={() => run(() => post("cancelJob", { id: j._id }), "Canceled").then(jobs.reload)}>
                          Cancel
                        </Button>
                      )}
                      {canWrite(admin) && (j.state === "failed" || j.state === "canceled") && (
                        <Button variant="ghost" disabled={busy} onClick={() => run(() => post("retryJob", { id: j._id }), "Scheduled again").then(jobs.reload)}>
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="scheduled">No scheduled jobs{state ? ` in state "${state}"` : ""}.</Empty>
        )}
      </section>
    </div>
  );
}
