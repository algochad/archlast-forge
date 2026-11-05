import { useState, type FormEvent, type ReactNode } from "react";
import { get, post, type Admin, type FirewallEvent, type FirewallInfo, type FirewallSettings, type FirewallTest } from "../api";
import { Icon } from "../brand";
import { Legend, TimeChart } from "../charts";
import { ago, clock, count, ms, plural } from "../format";
import { Callout, Card, Chips, usePages } from "../kit";
import { Badge, Button, Empty, ErrorNote, Field, Segmented, Skeleton, Stat, useAction, useAsync } from "../ui";

type Power = "off" | "detect" | "block";
/** What was changed in the form and not saved yet. */
type Edits = { enabled?: boolean } & Partial<FirewallSettings>;

const WINDOWS = [
  { value: "15", label: "15 min" },
  { value: "60", label: "1 hour" },
  { value: "360", label: "6 hours" },
  { value: "1440", label: "24 hours" },
];
const PARANOIA = [
  "1 · usual attacks, fewest false alarms",
  "2 · more rules, some false alarms",
  "3 · strict, tune it for your app",
  "4 · very strict, a lot of tuning",
];
const ACTION_TONE = { blocked: "bad", detected: "warn", error: "neutral" } as const;
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function Firewall({ admin }: { admin: Admin }) {
  const [minutes, setMinutes] = useState("60");
  const info = useAsync(() => get<FirewallInfo>("waf", { minutes: Number(minutes) }), [minutes], { interval: 3000 });
  const { run, busy } = useAction();
  const owner = admin.role === "owner";
  const d = info.data;
  if (!d) return info.error ? <ErrorNote error={info.error} /> : <Skeleton rows={8} />;
  const save = (change: Edits, done: string) => run(() => post("waf.save", change), done).then((r) => (info.reload(), r.ok));
  const disabled = new Set((d.settings ?? d.draft).disabledRules);

  return (
    <div className="stack">
      <ErrorNote error={info.error} />
      <State d={d} owner={owner} busy={busy} onEnable={() => save({ enabled: true, mode: "detect" }, "The firewall is on, in detect mode")} />
      <section className="stats" aria-label="Firewall summary">
        <Stat label="Inspected" icon="shield" value={count(d.counters.inspected)} hint={`${d.latency.p95 ? `p95 ${ms(d.latency.p95)}` : "nothing yet"} to inspect one`} trend={d.timeline.map((p) => p.inspected)} />
        <Stat
          label="Blocked"
          icon="errors"
          tone={d.counters.blocked ? "bad" : undefined}
          value={count(d.counters.blocked)}
          hint="answered 403 before they reached your code"
          trend={d.timeline.map((p) => p.blocked)}
        />
        <Stat
          label="Flagged in detect mode"
          icon="alerts"
          tone={d.counters.detected ? "ember" : undefined}
          value={count(d.counters.detected)}
          hint="would be blocked in block mode"
          trend={d.timeline.map((p) => p.detected)}
        />
        <Stat
          label="Couldn't inspect"
          icon="flame"
          tone={d.counters.errors ? "bad" : undefined}
          value={count(d.counters.errors)}
          hint={d.counters.errors ? (d.settings?.mode === "block" ? "refused with 503" : "let through") : "the firewall itself failing"}
          trend={d.timeline.map((p) => p.errors)}
        />
      </section>

      <Settings d={d} owner={owner} busy={busy} onSave={save} />

      <div className="toolbar-row">
        <Segmented label="Window" value={minutes} options={WINDOWS} onChange={setMinutes} />
        <span className="note-line">counts since this server started · {ago(d.since)}</span>
      </div>
      <div className="grid-2">
        <Card title="Flagged requests" extra={<Legend items={[{ label: "blocked", color: "var(--bad)" }, { label: "detected", color: "var(--warn)" }, { label: "couldn't inspect", color: "var(--viz-quiet)" }]} />}>
          <TimeChart
            points={d.timeline}
            step={60_000}
            height={140}
            marks={[{ kind: "bars", stack: [{ key: "blocked", label: "blocked", color: "var(--bad)" }, { key: "detected", label: "detected", color: "var(--warn)" }, { key: "errors", label: "couldn't inspect", color: "var(--viz-quiet)" }] }]}
            emptyLabel="Nothing was flagged in this window"
          />
        </Card>
        <Card title="Inspected requests" extra={<span className="note-line">{plural(d.counters.inspected, "request")} in all</span>}>
          <TimeChart points={d.timeline} step={60_000} height={140} marks={[{ kind: "line", key: "inspected", label: "inspected", color: "var(--viz-1)", area: true }]} emptyLabel="No requests were inspected" />
        </Card>
      </div>

      <Events events={d.events} owner={owner} busy={busy} enabled={d.enabled} ignored={d.settings?.ignorePaths ?? []} disabled={disabled} onSave={save} />

      <div className="grid-3">
        <Card title="Rules that matched most">
          <Top
            empty="No rule has matched yet"
            rows={d.rules.slice(0, 8).map((r) => ({
              key: r.id,
              label: (
                <>
                  <code className="field-name">{r.id}</code> <span className="muted small">{r.message}</span>
                </>
              ),
              count: r.count,
              blocked: r.blocked,
              detected: r.detected,
              action:
                owner && d.enabled && !disabled.has(r.id) ? (
                  <Button variant="ghost" disabled={busy} title="Switch this rule off" onClick={() => confirmRule(r.id, r.message) && save({ disabledRules: [...disabled, r.id] }, `Rule ${r.id} is off`)}>
                    Off
                  </Button>
                ) : undefined,
            }))}
          />
        </Card>
        <Card title="Paths that were flagged">
          <Top empty="No path has been flagged" rows={d.paths.slice(0, 8).map((p) => ({ key: p.path, label: <code>{p.path}</code>, count: p.count, blocked: p.blocked, detected: p.detected }))} />
        </Card>
        <Card title="Clients that were flagged">
          <Top empty="No client has been flagged" rows={d.ips.slice(0, 8).map((p) => ({ key: p.ip, label: <code>{p.ip}</code>, count: p.count, blocked: p.blocked, detected: p.detected }))} />
        </Card>
      </div>

      <div className="grid-3-1">
        <Tester d={d} admin={admin} disabled={disabled} busy={busy} onSave={save} />
        <Threads d={d} />
      </div>
    </div>
  );
}

const confirmRule = (id: number, message: string) =>
  confirm(`Switch off rule ${id}${message ? ` (${message})` : ""}? Requests it would have stopped get through, for every route of this app. Ignoring a path is narrower, if only one route needs it.`);

/** Whether it is on, in which mode, since when; or the way to turn it on. */
function State({ d, owner, busy, onEnable }: { d: FirewallInfo; owner: boolean; busy: boolean; onEnable: () => void }) {
  if (!d.enabled)
    return (
      <Callout
        tone="warn"
        icon="shield"
        title="The web application firewall is off"
        actions={
          owner ? (
            <Button disabled={busy} onClick={onEnable}>
              Turn on in detect mode
            </Button>
          ) : undefined
        }
      >
        Requests reach your functions, auth and HTTP endpoints without being checked against the OWASP Core Rule Set. Detect mode only watches: it logs and counts what the rules would stop, so you can see
        what blocking would do to your traffic before it blocks anything.{!owner && " An owner can turn it on."}
      </Callout>
    );
  const s = d.settings!;
  const down = d.threads.filter((t) => t.state !== "up").length;
  if (down)
    return (
      <Callout tone="bad" icon="errors" title="A firewall thread is not running">
        {s.mode === "block" ? "Requests that reach it are refused with 503 until it is back." : "Requests that reach it go through unchecked until it is back."} See the threads below for why.
      </Callout>
    );
  return s.mode === "detect" ? (
    <Callout tone="accent" icon="shield" title="Detect mode: the firewall is watching, not blocking">
      Nothing is stopped. Look through what was flagged below, switch off or ignore what is a false alarm, then move to Block.
    </Callout>
  ) : (
    <Callout tone="ok" icon="shield" title="Block mode: flagged requests are answered 403">
      On since {ago(d.onSince)}, paranoia level {s.paranoia}.
    </Callout>
  );
}

/** The firewall's controls: mode, strictness, what it leaves alone. Saved together, applied at once. */
function Settings({ d, owner, busy, onSave }: { d: FirewallInfo; owner: boolean; busy: boolean; onSave: (c: Edits, done: string) => Promise<boolean> }) {
  const base = d.settings ?? d.draft;
  const [edits, setEdits] = useState<Edits>({});
  const form = { ...base, ...edits };
  const enabled = edits.enabled ?? d.enabled;
  const power: Power = !enabled ? "off" : form.mode;
  const locked = (f: keyof FirewallInfo["draft"] | "enabled") => d.locked.includes(f);
  const editable = owner;
  const change: Edits = {};
  if (enabled !== d.enabled) change.enabled = enabled;
  if (enabled) {
    if (enabled !== d.enabled || form.mode !== base.mode) change.mode = form.mode;
    if (form.paranoia !== base.paranoia) change.paranoia = form.paranoia;
    if (form.workers !== base.workers) change.workers = form.workers;
    if (form.maxBodyKb !== base.maxBodyKb) change.maxBodyKb = form.maxBodyKb;
    if (!sameList(form.ignorePaths, base.ignorePaths)) change.ignorePaths = form.ignorePaths;
    if (!sameList(form.disabledRules, base.disabledRules)) change.disabledRules = form.disabledRules;
  }
  const dirty = Object.keys(change).length > 0;
  const names = new Map(d.rules.map((r) => [r.id, r.message]));
  const set = (e: Edits) => setEdits((cur) => ({ ...cur, ...e }));
  // What the environment gives stays as it is, so a locked field is left out of what a click changes.
  const pick = (p: Power) => {
    if (!locked("enabled")) set({ enabled: p !== "off" });
    if (p !== "off" && !locked("mode")) set({ mode: p });
  };

  const apply = async () => {
    if (change.enabled === false && !confirm("Turn the firewall off? Requests are no longer checked.")) return;
    if (enabled && change.mode === "block" && d.counters.detected > 0 && !confirm(`Detect mode flagged ${plural(d.counters.detected, "request")} since this server started. In block mode they get a 403. Switch to Block?`)) return;
    if (await onSave(change, enabled ? "Firewall settings applied" : "The firewall is off")) setEdits({});
  };

  return (
    <section className="panel stack" aria-label="Firewall settings">
      <div className="toolbar">
        <h3>Settings</h3>
        <span className="push" />
        {dirty && (
          <Button variant="ghost" disabled={busy} onClick={() => setEdits({})}>
            Discard
          </Button>
        )}
        {editable && (
          <Button disabled={busy || !dirty} onClick={apply}>
            Apply
          </Button>
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Changes apply at once, without a restart: new threads load the rules while the old ones finish what they are doing, and if the rules can't load nothing changes. They are saved as the
        engine's <code>WAF_*</code> settings. {!owner && "Only an owner can change them."} Other servers of this app pick them up when they restart.
      </p>
      <div className="fw-form">
        <Field label="Mode" hint={locked("enabled") || locked("mode") ? "Set in the environment (WAF, WAF_MODE)" : undefined}>
          {() => (
            <Segmented
              label="Mode"
              value={power}
              options={[
                { value: "off", label: "Off" },
                { value: "detect", label: "Detect" },
                { value: "block", label: "Block" },
              ]}
              onChange={(p) => editable && pick(p)}
            />
          )}
        </Field>
        <Field label="Paranoia level" hint={locked("paranoia") ? "Set in the environment (WAF_PARANOIA)" : "How strict the rules are"}>
          {(id) => (
            <select id={id} value={form.paranoia} disabled={!editable || !enabled || locked("paranoia")} onChange={(e) => set({ paranoia: Number(e.target.value) })}>
              {PARANOIA.map((label, i) => (
                <option key={i} value={i + 1}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Threads" hint={locked("workers") ? "Set in the environment (WAF_WORKERS)" : "Each holds its own copy of the rules: over 100 MB"}>
          {(id) => <input id={id} type="number" min={1} max={16} value={form.workers} disabled={!editable || !enabled || locked("workers")} onChange={(e) => set({ workers: Math.max(1, Number(e.target.value) || 1) })} />}
        </Field>
        <Field label="Largest body inspected (KB)" hint={locked("maxBodyKb") ? "Set in the environment (WAF_MAX_BODY_KB)" : "A larger body isn't inspected; its URL and headers still are"}>
          {(id) => <input id={id} type="number" min={1} value={form.maxBodyKb} disabled={!editable || !enabled || locked("maxBodyKb")} onChange={(e) => set({ maxBodyKb: Math.max(1, Number(e.target.value) || 1) })} />}
        </Field>
      </div>
      <div className="grid-2">
        <ListEditor
          label="Ignored paths"
          hint="Requests under these prefixes aren't inspected, like /webhooks. The dashboard, storage and the app's built files never are."
          values={form.ignorePaths}
          disabled={!editable || !enabled || locked("ignorePaths")}
          lockedNote={locked("ignorePaths") ? "Set in the environment (WAF_IGNORE_PATHS)" : undefined}
          placeholder="/webhooks"
          parse={(text) => (text.startsWith("/") ? text.replace(/\/+$/, "") || undefined : undefined)}
          invalid="A path prefix starts with /"
          onChange={(ignorePaths) => set({ ignorePaths })}
        />
        <ListEditor
          label="Rules switched off"
          hint="CRS rule ids that no longer count, for a rule that stops something legitimate in this app."
          values={form.disabledRules}
          disabled={!editable || !enabled || locked("disabledRules")}
          lockedNote={locked("disabledRules") ? "Set in the environment (WAF_DISABLED_RULES)" : undefined}
          placeholder="942100"
          parse={(text) => (/^\d{3,7}$/.test(text) ? Number(text) : undefined)}
          invalid="A rule id is a number like 942100"
          describe={(id) => names.get(id)}
          onChange={(disabledRules) => set({ disabledRules })}
        />
      </div>
    </section>
  );
}

/** A list of values shown as removable chips, with a field to add one. */
function ListEditor<T extends string | number>({
  label,
  hint,
  values,
  onChange,
  parse,
  placeholder,
  invalid,
  disabled,
  lockedNote,
  describe,
}: {
  label: string;
  hint: string;
  values: T[];
  onChange: (v: T[]) => void;
  parse: (text: string) => T | undefined;
  placeholder: string;
  invalid: string;
  disabled: boolean;
  lockedNote?: string;
  describe?: (v: T) => string | undefined;
}) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const raw = text.trim();
    if (!raw) return;
    const v = parse(raw);
    if (v === undefined) return setBad(true);
    if (!values.includes(v)) onChange([...values, v]);
    setText("");
    setBad(false);
  };
  return (
    <div className="field">
      <label htmlFor={`list-${label}`}>
        {label} {lockedNote && <Badge tone="warn">environment</Badge>}
      </label>
      <div className="chips-row" role="list" aria-label={label}>
        {values.length === 0 && <span className="muted small">None</span>}
        {values.map((v) => (
          <span key={v} role="listitem" className="chip" style={{ borderStyle: "solid" }} title={describe?.(v)}>
            <code>{v}</code>
            {describe?.(v) && <span className="muted small">{describe(v)}</span>}
            {!disabled && (
              <button type="button" className="fw-x" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                <Icon name="x" size={12} />
              </button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <form onSubmit={add} className="toolbar-row" style={{ marginTop: "0.4rem" }}>
          <input id={`list-${label}`} value={text} placeholder={placeholder} aria-invalid={bad} onChange={(e) => (setText(e.target.value), setBad(false))} />
          <Button type="submit" variant="ghost">
            Add
          </Button>
        </form>
      )}
      <small className={bad ? "bad" : "muted"}>{bad ? invalid : (lockedNote ?? hint)}</small>
    </div>
  );
}

type TopRow = { key: string | number; label: ReactNode; count: number; blocked: number; detected: number; action?: ReactNode };

function Top({ rows, empty }: { rows: TopRow[]; empty: string }) {
  if (!rows.length) return <Empty icon="shield">{empty}</Empty>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <ul className="ranked">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="toolbar-row" style={{ flexWrap: "nowrap", gridColumn: "1 / -1" }}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{r.label}</span>
            <span className="push" />
            <span className="num small" title={`${r.blocked} blocked · ${r.detected} detected`}>
              {count(r.count)}
            </span>
            {r.action}
          </div>
          <span className="rk-bar" aria-hidden="true">
            <i style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What was blocked and flagged, newest first. A row opens to the rules behind it, with the way to stop them. */
function Events({
  events,
  owner,
  busy,
  enabled,
  ignored,
  disabled,
  onSave,
}: {
  events: FirewallEvent[];
  owner: boolean;
  busy: boolean;
  enabled: boolean;
  ignored: string[];
  disabled: Set<number>;
  onSave: (c: Edits, done: string) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState<"all" | FirewallEvent["action"]>("all");
  const [open, setOpen] = useState<number>();
  const shown = events.filter((e) => filter === "all" || e.action === filter);
  const { rows, pager } = usePages(shown, 10);
  const n = (a: FirewallEvent["action"]) => events.filter((e) => e.action === a).length;
  return (
    <section className="panel stack" aria-label="Recent events">
      <div className="toolbar">
        <h3>Recent events</h3>
        <span className="muted small">the last {events.length} since this server started; the query string is left out</span>
        <span className="push" />
        <Chips
          label="Action"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: events.length },
            { value: "blocked", label: "Blocked", count: n("blocked") },
            { value: "detected", label: "Detected", count: n("detected") },
            { value: "error", label: "Errors", count: n("error") },
          ]}
        />
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Request</th>
                <th scope="col">Client</th>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col">Rules</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((e) => {
                const isOpen = open === e.id;
                const line = (
                  <tr
                    key={e.id}
                    tabIndex={0}
                    onClick={() => setOpen(isOpen ? undefined : e.id)}
                    onKeyDown={(k) => k.key === "Enter" && setOpen(isOpen ? undefined : e.id)}
                    style={{ cursor: "pointer" }}
                    aria-expanded={isOpen}
                  >
                    <td title={new Date(e.at).toLocaleString()}>
                      {clock(e.at)} <span className="muted small">{ago(e.at)}</span>
                    </td>
                    <td>
                      <Badge tone={ACTION_TONE[e.action]}>{e.action === "error" ? "couldn't inspect" : e.action}</Badge>
                    </td>
                    <td>
                      <code>
                        {e.method} {e.path}
                      </code>
                    </td>
                    <td>
                      <code>{e.ip}</code>
                    </td>
                    <td className="num">{e.score || "—"}</td>
                    <td>
                      {e.error ? <span className="muted small">{e.error}</span> : e.rules.length ? e.rules.map((r) => r.id).join(", ") : "—"}
                    </td>
                  </tr>
                );
                if (!isOpen) return [line];
                return [
                  line,
                  <tr key={`${e.id}-open`}>
                    <td colSpan={6}>
                      <div className="stack" style={{ gap: "0.5rem" }}>
                        {e.rules.map((r) => (
                          <div key={r.id} className="toolbar-row">
                            <code className="field-name">{r.id}</code>
                            <span>{r.message}</span>
                            <span className="push" />
                            {owner && enabled && (
                              <Button
                                variant="ghost"
                                disabled={busy || disabled.has(r.id)}
                                onClick={() => confirmRule(r.id, r.message) && onSave({ disabledRules: [...disabled, r.id] }, `Rule ${r.id} is off`)}
                              >
                                {disabled.has(r.id) ? "Already off" : "Switch rule off"}
                              </Button>
                            )}
                          </div>
                        ))}
                        <div className="toolbar-row">
                          <span className="muted small">
                            request <code>{e.requestId}</code> · inspected in {ms(e.ms)}
                          </span>
                          <span className="push" />
                          {owner && enabled && e.action !== "error" && (
                            <Button
                              variant="ghost"
                              disabled={busy || ignored.some((p) => e.path === p || e.path.startsWith(`${p}/`))}
                              onClick={() => confirm(`Stop inspecting ${e.path}? Nothing under it is checked, whatever it holds.`) && onSave({ ignorePaths: [...ignored, e.path] }, `${e.path} is ignored`)}
                            >
                              Ignore this path
                            </Button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="shield">{enabled ? "Nothing has been flagged yet. Requests that match the rules show up here." : "The firewall is off, so nothing is being checked."}</Empty>
      )}
      {pager}
    </section>
  );
}

const SAMPLES: { label: string; path: string; body?: string; method?: string }[] = [
  { label: "SQL injection", path: "/rpc/todos:list?q=1' OR '1'='1' --" },
  { label: "Script", path: "/search?q=<script>alert(1)</script>" },
  { label: "Path traversal", path: "/files?name=../../../../etc/passwd" },
  { label: "Clean call", path: "/rpc/todos:list?args=%7B%7D" },
];

/** Describe a request and see what the rules make of it, without it being counted, to decide what to tune. */
function Tester({ d, admin, disabled, busy, onSave }: { d: FirewallInfo; admin: Admin; disabled: Set<number>; busy: boolean; onSave: (c: Edits, done: string) => Promise<boolean> }) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/rpc/todos:list?args=%7B%7D");
  const [headers, setHeaders] = useState("");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<FirewallTest>();
  const { run, busy: running } = useAction();
  const can = admin.role !== "viewer" && d.enabled;

  const go = async (e?: FormEvent) => {
    e?.preventDefault();
    const parsed: Record<string, string> = {};
    for (const line of headers.split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) parsed[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    if (body && !Object.keys(parsed).some((h) => h.toLowerCase() === "content-type")) parsed["content-type"] = "application/json";
    const r = await run(() => post<FirewallTest>("waf.test", { method, path, headers: parsed, body }));
    if (r.ok) setResult(r.value);
  };

  return (
    <section className="panel stack" aria-label="Try a request">
      <div className="toolbar">
        <h3>Try a request</h3>
        <span className="muted small">through the live rules; not counted, not sent anywhere</span>
      </div>
      {!can ? (
        <Empty icon="shield">{d.enabled ? "Only admins and owners can try requests." : "Turn the firewall on to try requests against its rules."}</Empty>
      ) : (
        <form className="stack" onSubmit={go}>
          <div className="chips-row" aria-label="Examples">
            {SAMPLES.map((s) => (
              <button key={s.label} type="button" className="chip" onClick={() => (setMethod(s.method ?? "GET"), setPath(s.path), setBody(s.body ?? ""), setResult(undefined))}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="toolbar-row" style={{ flexWrap: "nowrap" }}>
            <select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: "auto" }}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input aria-label="Path and query" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path?query=1" spellCheck={false} style={{ flex: 1 }} />
            <Button type="submit" disabled={running}>
              Run
            </Button>
          </div>
          <div className="grid-2">
            <Field label="Headers" hint="One per line, Name: value. A Host and User-Agent are added when missing.">
              {(id) => <textarea id={id} className="code" rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} spellCheck={false} />}
            </Field>
            <Field label="Body" hint={method === "GET" ? "Not sent with GET" : "Sent as JSON unless a Content-Type is given"}>
              {(id) => <textarea id={id} className="code" rows={3} value={body} disabled={method === "GET"} onChange={(e) => setBody(e.target.value)} spellCheck={false} />}
            </Field>
          </div>
        </form>
      )}
      {result && <Verdict r={result} hadBody={method !== "GET" && body !== ""} owner={admin.role === "owner"} disabled={disabled} busy={busy} onSave={onSave} />}
    </section>
  );
}

function Verdict({ r, hadBody, owner, disabled, busy, onSave }: { r: FirewallTest; hadBody: boolean; owner: boolean; disabled: Set<number>; busy: boolean; onSave: (c: Edits, done: string) => Promise<boolean> }) {
  const stopped = r.score >= r.threshold;
  return (
    <div className="stack" aria-live="polite">
      <div className="toolbar-row">
        <Badge tone={r.action === "blocked" ? "bad" : r.action === "detected" ? "warn" : "ok"}>{r.action === "detected" ? "detected" : r.action}</Badge>
        <span>
          {r.action === "blocked"
            ? "The rules stop this request: it would get a 403."
            : r.action === "detected"
              ? "Detect mode: the rules would stop it, and it goes through."
              : stopped
                ? "Allowed: its matches are in rules you switched off."
                : "The rules let it through."}
        </span>
        <span className="push" />
        <span className="small muted">
          score <b className={stopped ? "bad" : undefined}>{r.score}</b> of {r.threshold}
        </span>
      </div>
      {r.skipped && (
        <Callout tone="warn" icon="shield" title="A real request like this isn't inspected">
          {r.skipped}. This is what the rules would say if it were.
        </Callout>
      )}
      {hadBody && !r.bodyInspected && <p className="muted small">The body was over the limit, so the rules saw the URL and headers only.</p>}
      {r.rules.length ? (
        <ul className="ranked">
          {r.rules.map((m) => (
            <li key={m.id}>
              <div className="toolbar-row" style={{ flexWrap: "nowrap", gridColumn: "1 / -1" }}>
                <code className="field-name">{m.id}</code>
                <span>{m.message}</span>
                <span className="push" />
                {owner && !disabled.has(m.id) && m.id < 949000 && (
                  <Button variant="ghost" disabled={busy} onClick={() => confirmRule(m.id, m.message) && onSave({ disabledRules: [...disabled, m.id] }, `Rule ${m.id} is off`)}>
                    Off
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No rule matched.</p>
      )}
    </div>
  );
}

function Threads({ d }: { d: FirewallInfo }) {
  return (
    <section className="panel stack" aria-label="Threads">
      <h3>Threads</h3>
      {d.threads.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  Waiting
                </th>
                <th scope="col" className="num">
                  Served
                </th>
                <th scope="col" className="num">
                  Restarts
                </th>
              </tr>
            </thead>
            <tbody>
              {d.threads.map((t, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <Badge tone={t.state === "up" ? "ok" : t.state === "starting" ? "neutral" : "bad"}>{t.state}</Badge>
                  </td>
                  <td className="num">{t.waiting}</td>
                  <td className="num">{count(t.served)}</td>
                  <td className="num" title={t.lastError}>
                    {t.restarts}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No threads run while the firewall is off.</p>
      )}
      {d.threads.some((t) => t.lastError) && <p className="muted small">Last restart: {d.threads.find((t) => t.lastError)!.lastError}</p>}
      <p className="muted small">
        A thread that doesn't answer a request in 3 seconds is replaced. Inspection takes about {d.latency.avg ? ms(d.latency.avg) : "a millisecond"} on average here, {ms(d.latency.p99)} at p99, {ms(d.latency.max)} at worst.
      </p>
    </section>
  );
}
