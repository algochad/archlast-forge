import { get } from "../api";
import { Empty, ErrorNote, Spinner, useAsync } from "../ui";

type Entry = { _id: string; time: number; actor: string; action: string; target: string | null; details: string | null };

export function Audit() {
  const audit = useAsync(() => get<Entry[]>("audit", { limit: 300 }), [], { interval: 10_000 });
  return (
    <section className="panel stack" aria-label="Audit log">
      <p className="muted small">Every change made from the dashboard: who, what, and with which arguments.</p>
      <ErrorNote error={audit.error} />
      {audit.loading && !audit.data ? (
        <Spinner />
      ) : audit.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">time</th>
                <th scope="col">admin</th>
                <th scope="col">action</th>
                <th scope="col">target</th>
                <th scope="col">details</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((e) => (
                <tr key={e._id}>
                  <td className="muted nowrap">{new Date(e.time).toLocaleString()}</td>
                  <td>{e.actor}</td>
                  <td>{e.action}</td>
                  <td className="mono small">{e.target}</td>
                  <td>
                    <code className="cell-code">{e.details}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No dashboard changes yet.</Empty>
      )}
    </section>
  );
}
