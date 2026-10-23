import { ago, canWrite, get, post, typeOf, type Admin, type Manifest } from "../api";
import { Badge, Button, Empty, useAction, useAsync } from "../ui";

type Sub = { name: string; args: unknown; topics: string[]; since: number };

export function Settings({ manifest, admin }: { manifest: Manifest; admin: Admin }) {
  const env = useAsync(() => get<{ name: string; updatedAt: number }[]>("env"), []);
  const subs = useAsync(() => get<Sub[]>("subscriptions"), [], { interval: 3000 });
  const { run, busy } = useAction();
  return (
    <div className="stack">
      <section className="panel" aria-label="Schema">
        <h3>Schema</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">table</th>
                <th scope="col">fields</th>
                <th scope="col">indexes</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(manifest.tables).map(([name, t]) => (
                <tr key={name}>
                  <td>
                    {name} {!t.strict && <Badge tone="accent">Better Auth</Badge>}
                  </td>
                  <td>
                    {Object.entries(t.fields).map(([k, v]) => (
                      <div key={k}>
                        <code>
                          {k}
                          {v.optional ? "?" : ""}: <span className="muted">{typeOf(v)}</span>
                        </code>
                      </div>
                    ))}
                  </td>
                  <td>
                    {Object.entries(t.indexes).map(([i, f]) => (
                      <div key={i}>
                        <code>
                          {i}: [{f.join(", ")}]
                        </code>
                      </div>
                    ))}
                    {Object.entries(t.searchIndexes ?? {}).map(([i, s]) => (
                      <div key={i}>
                        <code>
                          {i}: search {s.searchField}
                          {s.filterFields.length ? ` filter [${s.filterFields.join(", ")}]` : ""}
                        </code>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel stack" aria-label="Environment variables">
        <div className="toolbar">
          <h3>Environment variables</h3>
          {canWrite(admin) && (
            <Button variant="ghost" className="push" disabled={busy} onClick={() => run(() => post("reload"), "Function runtime reloaded")}>
              Reload runtime
            </Button>
          )}
        </div>
        <p className="muted small">
          Set with <code>archlast-forge env set NAME value</code>. Values stay on the server.
        </p>
        {env.data?.length ? (
          <ul className="plain">
            {env.data.map((e) => (
              <li key={e.name}>
                <code>{e.name}</code> <span className="muted small">updated {ago(e.updatedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="settings">None set.</Empty>
        )}
      </section>
      <section className="panel" aria-label="Live subscriptions">
        <h3>Live subscriptions on this server</h3>
        {subs.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">query</th>
                  <th scope="col">args</th>
                  <th scope="col">topics</th>
                  <th scope="col">since</th>
                </tr>
              </thead>
              <tbody>
                {subs.data.map((s, i) => (
                  <tr key={i}>
                    <td>{s.name}</td>
                    <td>
                      <code className="cell-code">{JSON.stringify(s.args)}</code>
                    </td>
                    <td>
                      {s.topics.map((t) => (
                        <div key={t}>
                          <code className="cell-code">{t}</code>
                        </div>
                      ))}
                    </td>
                    <td className="muted nowrap">{ago(s.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="settings">No live subscriptions.</Empty>
        )}
      </section>
    </div>
  );
}
