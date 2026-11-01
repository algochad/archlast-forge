import { useMemo, useState, type FormEvent } from "react";
import { ago, canWrite, get, post, typeOf, type Admin, type Manifest } from "../api";
import { Icon } from "../brand";
import { Callout, Chips, SearchBox } from "../kit";
import { Badge, Button, Empty, ErrorNote, Skeleton, useAction, useAsync, useToast } from "../ui";

type Sub = { name: string; args: unknown; topics: string[]; since: number };
type Setting = {
  name: string;
  group: string;
  type: "int" | "bool" | "enum" | "string" | "list" | "cron";
  options?: string[];
  min?: number;
  default: string;
  doc: string;
  envOnly?: string;
  secret?: boolean;
  live?: boolean;
  source: "environment" | "dashboard" | "default";
  isSet: boolean;
  value: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  pending: boolean;
};
type SettingsInfo = { restartable: boolean; storedError: string | null; settings: Setting[] };

/** Polls until the server answers again after a restart (it is down for a moment). */
async function waitForServer() {
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 120; i++) {
    const ok = await fetch("/_admin/me", { credentials: "same-origin" }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The server hasn't come back after a minute; check its logs");
}

export function Settings({ manifest, admin }: { manifest: Manifest; admin: Admin }) {
  const subs = useAsync(() => get<Sub[]>("subscriptions"), [], { interval: 3000 });
  return (
    <div className="stack">
      <EngineSettings admin={admin} />
      <EnvVars admin={admin} />
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

function EngineSettings({ admin }: { admin: Admin }) {
  const info = useAsync(() => get<SettingsInfo>("settings"), []);
  const [group, setGroup] = useState("all");
  const [q, setQ] = useState("");
  const { run, busy } = useAction();
  const toast = useToast();
  const owner = admin.role === "owner";
  const all = info.data?.settings ?? [];
  const groups = useMemo(() => [...new Set(all.map((s) => s.group))], [all]);
  const shown = all.filter((s) => (group === "all" || s.group === group) && (!q || `${s.name} ${s.doc}`.toLowerCase().includes(q.toLowerCase())));
  const pending = all.filter((s) => s.pending);
  const restart = () =>
    run(async () => {
      await post("restart");
      toast("Restarting…");
      await waitForServer();
      info.reload();
    }, "Restarted with the saved settings");

  return (
    <section className="panel stack" aria-label="Engine settings">
      <div className="toolbar">
        <h3>Engine settings</h3>
        <span className="push" />
        <SearchBox value={q} onChange={setQ} placeholder="Find a setting…" />
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Everything the engine reads from its environment. Values set here are kept in the database; a variable set where the engine is deployed (<code>.env</code>, <code>compose.yaml</code>)
        always wins over them. Backup settings apply at once, the rest when the server restarts.
      </p>
      {info.data?.storedError && (
        <Callout tone="bad" icon="errors" title="The saved settings were not applied">
          {info.data.storedError}. Fix or clear the setting it names, then restart.
        </Callout>
      )}
      {pending.length > 0 && (
        <Callout
          tone="warn"
          icon="refresh"
          title={`${pending.length} saved ${pending.length === 1 ? "setting waits" : "settings wait"} for a restart`}
          actions={
            owner && info.data?.restartable ? (
              <Button disabled={busy} onClick={() => confirm("Restart the server now? Open connections reconnect in a moment.") && restart()}>
                <Icon name="refresh" size={14} /> Restart now
              </Button>
            ) : undefined
          }
        >
          {pending.map((s) => s.name).join(", ")}.{" "}
          {info.data?.restartable ? "A restart takes a few seconds; clients reconnect by themselves." : "Restart the server's process or container to apply them."}
        </Callout>
      )}
      <Chips
        label="Group"
        value={group}
        onChange={setGroup}
        options={[{ value: "all", label: "All" }, ...groups.map((g) => ({ value: g, label: g, count: all.filter((s) => s.group === g).length }))]}
      />
      <ErrorNote error={info.error} />
      {!info.data ? (
        <Skeleton rows={8} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">setting</th>
                <th scope="col">value</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <SettingRow
                  key={s.name}
                  s={s}
                  editable={owner}
                  busy={busy}
                  save={(value) => run(() => post("saveSetting", { name: s.name, value }), value === null ? `${s.name} back to its default` : `${s.name} saved`).then(info.reload)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!owner && <p className="muted small">Only owners change settings.</p>}
    </section>
  );
}

function SettingRow({ s, editable, busy, save }: { s: Setting; editable: boolean; busy: boolean; save: (value: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const locked = Boolean(s.envOnly) || s.source === "environment";
  const shown = s.secret ? (s.isSet ? "set (hidden)" : "not set") : (s.value ?? "");
  const value = draft ?? (s.secret ? "" : (s.value ?? ""));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(value === "" ? null : value);
    setDraft(null);
  };
  return (
    <tr>
      <td style={{ maxWidth: 420 }}>
        <div>
          <code className="field-name">{s.name}</code> {s.live && <Badge tone="ok">applies at once</Badge>} {s.pending && <Badge tone="warn">restart to apply</Badge>}
        </div>
        <div className="muted small">{s.doc}</div>
        <div className="faint small">Default: {s.default}</div>
      </td>
      <td>
        {locked || !editable ? (
          <div className="stack" style={{ gap: "0.25rem" }}>
            <span className={s.value === null && !s.isSet ? "muted" : "mono"}>{s.value === null && !s.isSet ? "default" : shown}</span>
            <span className="small muted">
              {s.source === "environment" ? (
                <>
                  <Icon name="key" size={12} /> set in the environment{s.envOnly ? "" : ", which wins over this page"}
                </>
              ) : s.source === "dashboard" ? (
                `set here ${s.updatedAt ? ago(s.updatedAt) : ""}${s.updatedBy ? ` by ${s.updatedBy === "admin-key" ? "the admin key" : s.updatedBy}` : ""}`
              ) : null}
              {s.envOnly && (
                <span title={s.envOnly}>
                  {s.source === "environment" ? " · " : ""}environment only: {s.envOnly}
                </span>
              )}
            </span>
          </div>
        ) : (
          <form className="toolbar" onSubmit={submit} style={{ flexWrap: "wrap" }}>
            <label className="sr-only" htmlFor={`setting-${s.name}`}>
              {s.name}
            </label>
            {s.type === "bool" ? (
              <select id={`setting-${s.name}`} value={value} onChange={(e) => setDraft(e.target.value)}>
                <option value="">default</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            ) : s.type === "enum" ? (
              <select id={`setting-${s.name}`} value={value} onChange={(e) => setDraft(e.target.value)}>
                <option value="">default</option>
                {s.options!.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`setting-${s.name}`}
                className="mono"
                type={s.secret ? "password" : s.type === "int" ? "number" : "text"}
                min={s.type === "int" ? s.min : undefined}
                value={value}
                placeholder={s.secret && s.isSet ? "set — type to replace" : "default"}
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
                style={{ minWidth: 200 }}
              />
            )}
            <Button type="submit" variant="ghost" disabled={busy || draft === null}>
              Save
            </Button>
            {s.source === "dashboard" && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => (save(null), setDraft(null))} title="Remove the saved value">
                Reset
              </Button>
            )}
          </form>
        )}
      </td>
    </tr>
  );
}

/** Variables your functions read from process.env (`archlast-forge env`). Values are never sent back to the dashboard. */
function EnvVars({ admin }: { admin: Admin }) {
  const env = useAsync(() => get<{ name: string; updatedAt: number }[]>("env"), []);
  const { run, busy } = useAction();
  const owner = admin.role === "owner";
  return (
    <section className="panel stack" aria-label="Environment variables">
      <div className="toolbar">
        <h3>Function environment variables</h3>
        {canWrite(admin) && (
          <Button variant="ghost" className="push" disabled={busy} onClick={() => run(() => post("reload"), "Function runtime reloaded")}>
            Reload runtime
          </Button>
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        What your functions read from <code>process.env</code> (also <code>archlast-forge env set NAME value</code>). Values stay on the server; a change applies when the runtime reloads.
      </p>
      {env.data?.length ? (
        <ul className="plain">
          {env.data.map((e) => (
            <li key={e.name} className="toolbar">
              <code>{e.name}</code> <span className="muted small">updated {ago(e.updatedAt)}</span>
              {owner && (
                <Button
                  variant="ghost"
                  className="icon-only push"
                  aria-label={`Remove ${e.name}`}
                  title="Remove"
                  disabled={busy}
                  onClick={() => confirm(`Remove ${e.name}?`) && run(() => post("env.remove", { name: e.name }), `${e.name} removed; reload the runtime to apply`).then(env.reload)}
                >
                  <Icon name="trash" size={14} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="settings">None set.</Empty>
      )}
      {owner && (
        <form
          className="toolbar"
          style={{ flexWrap: "wrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            void run(() => post("env.set", { name: String(f.get("name")), value: String(f.get("value")) }), "Saved; reload the runtime to apply").then((r) => {
              if (r.ok) (form.reset(), env.reload());
            });
          }}
        >
          <input name="name" className="mono" placeholder="NAME" aria-label="Variable name" pattern="[A-Za-z_][A-Za-z0-9_]*" required />
          <input name="value" type="password" placeholder="value" aria-label="Value" autoComplete="off" style={{ minWidth: 240 }} />
          <Button type="submit" variant="ghost" disabled={busy}>
            <Icon name="plus" size={14} /> Set
          </Button>
        </form>
      )}
    </section>
  );
}
