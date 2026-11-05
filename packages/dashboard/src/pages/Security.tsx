import { useState } from "react";
import { get, post, type Admin } from "../api";
import { Icon } from "../brand";
import { ago, clock } from "../format";
import { Callout, Card, Chips } from "../kit";
import { Badge, Button, Empty, ErrorNote, Field, Segmented, Skeleton, useAction, useAsync } from "../ui";

type Surface = "api" | "app" | "dashboard";
type Override = {
  enabled?: boolean;
  csp?: "enforce" | "report-only" | "off";
  add?: Record<string, string[]>;
  directives?: Record<string, string[] | null>;
  hsts?: false | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  frameOptions?: "DENY" | "SAMEORIGIN" | false;
  referrerPolicy?: string | false;
  crossOriginResourcePolicy?: "same-origin" | "same-site" | "cross-origin" | false;
  crossOriginOpenerPolicy?: "same-origin" | "same-origin-allow-popups" | "unsafe-none" | false;
};
type Overrides = Partial<Record<Surface, Override>>;
type Info = {
  enabled: boolean;
  reportPath: string | null;
  surfaces: { surface: Surface; on: boolean; code: "default" | "customized" | "off"; override: Override | null; headers: { name: string; value: string }[] }[];
  reports: { at: number; surface: string; directive: string; blocked: string; page: string; sample?: string; disposition: "enforce" | "report" }[];
  locked: { enabled: boolean; overrides: boolean };
  saved: Overrides;
};

const LABEL: Record<Surface, { title: string; blurb: string }> = {
  api: { title: "REST API", blurb: "Your Nest controllers' answers (nest(http, ...)). JSON never renders, so nothing may load from it or frame it." },
  app: { title: "App pages", blurb: "Your full-stack app's pages and files. Inline scripts run only with the page's nonce; your bundle, styles, images, fonts and https APIs and SDKs load." },
  dashboard: { title: "Dashboard", blurb: "This dashboard and its API: only its own files, no framing, no referrer, never cached." },
};
const DIRECTIVES = ["script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "frame-src", "worker-src", "form-action", "frame-ancestors", "default-src"];
const REFERRERS = ["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "origin", "no-referrer-when-downgrade"];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
/** An override without the keys that say nothing, so "default" leaves nothing behind. */
function clean(o: Override): Override | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === "object" && v && !Array.isArray(v) && !Object.keys(v).length))) as Override;
  return Object.keys(out).length ? out : undefined;
}

export function Security({ admin }: { admin: Admin }) {
  const info = useAsync(() => get<Info>("security"), [], { interval: 5000 });
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<Overrides | null>(null);
  const d = info.data;
  if (!d) return info.error ? <ErrorNote error={info.error} /> : <Skeleton rows={8} />;
  const owner = admin.role === "owner";
  const editable = owner && !d.locked.overrides;
  const overrides = draft ?? d.saved;
  const dirty = draft !== null && !same(draft, d.saved);
  const setSurface = (s: Surface, o: Override) => {
    const next = { ...overrides };
    const c = clean(o);
    if (c) next[s] = c;
    else delete next[s];
    setDraft(next);
  };
  const save = (body: object, done: string) => run(() => post("security.save", body), done).then((r) => (info.reload(), r.ok));

  return (
    <div className="stack">
      <ErrorNote error={info.error} />
      <Callout
        tone={d.enabled ? "ok" : "warn"}
        icon="lock"
        title={d.enabled ? "Security headers are on" : "Security headers are off"}
        actions={
          owner && !d.locked.enabled ? (
            <Button
              variant={d.enabled ? "ghost" : "primary"}
              disabled={busy}
              onClick={() => (d.enabled ? confirm("Turn every security header off, on the API, the app's pages and this dashboard?") : true) && save({ enabled: !d.enabled }, d.enabled ? "Security headers are off" : "Security headers are on")}
            >
              {d.enabled ? "Turn all off" : "Turn on"}
            </Button>
          ) : undefined
        }
      >
        Helmet sets them on three kinds of answer, each from a preset of the engine, then what your code says (<code>http.helmet()</code>, <code>nest(http, {"{ helmet }"})</code>), then what is set
        here, which wins. A header a handler sets itself is never replaced. Changes apply at once and are saved as <code>HELMET</code> and <code>HELMET_CONFIG</code>.
        {d.locked.overrides && " HELMET_CONFIG is set in the environment, which wins over this page."}
        {d.locked.enabled && " HELMET is set in the environment."}
        {!owner && " Only an owner can change them."}
      </Callout>

      {dirty && (
        <div className="toolbar-row">
          <Badge tone="warn">unsaved changes</Badge>
          <span className="push" />
          <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
            Discard
          </Button>
          <Button disabled={busy} onClick={() => save({ overrides }, "Security headers applied").then((ok) => ok && setDraft(null))}>
            Apply
          </Button>
        </div>
      )}

      {d.surfaces.map((s) => (
        <SurfaceCard key={s.surface} s={s} override={overrides[s.surface] ?? {}} editable={editable} onChange={(o) => setSurface(s.surface, o)} />
      ))}

      <Reports d={d} admin={admin} busy={busy} onClear={() => run(() => post("security.clearReports"), "Reports cleared").then(() => info.reload())} />
    </div>
  );
}

function SurfaceCard({ s, override, editable, onChange }: { s: Info["surfaces"][number]; override: Override; editable: boolean; onChange: (o: Override) => void }) {
  const [directive, setDirective] = useState("img-src");
  const [source, setSource] = useState("");
  const [bad, setBad] = useState(false);
  const set = (patch: Partial<Override>) => onChange({ ...override, ...patch });
  const csp = s.headers.find((h) => h.name === "content-security-policy" || h.name === "content-security-policy-report-only");
  const mode = !csp ? "off" : csp.name.endsWith("report-only") ? "report-only" : "enforce";
  const addSource = () => {
    const v = source.trim();
    if (!v) return;
    if (/[;,\s]/.test(v) || !(/^'[a-z-]+'$/.test(v) || /^[a-z]+:$/.test(v) || /^(https?|wss?):\/\/[^/]+$/.test(v) || /^\*\.[^/]+$/.test(v) || /^[a-z0-9.-]+(:\d+)?$/i.test(v))) return setBad(true);
    const list = override.add?.[directive] ?? [];
    if (!list.includes(v)) set({ add: { ...override.add, [directive]: [...list, v] } });
    setSource("");
    setBad(false);
  };
  const removeSource = (dir: string, v: string) => {
    const left = (override.add?.[dir] ?? []).filter((x) => x !== v);
    const add = { ...override.add };
    if (left.length) add[dir] = left;
    else delete add[dir];
    set({ add });
  };

  return (
    <Card
      title={
        <>
          {LABEL[s.surface].title}{" "}
          <Badge tone={!s.on ? "neutral" : mode === "enforce" ? "ok" : mode === "report-only" ? "warn" : "neutral"}>{!s.on ? "off" : mode === "off" ? "no CSP" : mode === "report-only" ? "CSP report-only" : "on"}</Badge>{" "}
          <span className="muted small">{s.code === "default" ? "engine preset" : s.code === "off" ? "off in code" : "customized in code"}</span>
        </>
      }
    >
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          {LABEL[s.surface].blurb}
        </p>
        {editable && (
          <>
            <div className="sec-form">
              <Field label="Headers">
                {() => (
                  <Segmented
                    label="Headers"
                    value={override.enabled === false ? "off" : override.enabled === true ? "on" : "default"}
                    options={[
                      { value: "default", label: "Default" },
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                    onChange={(v) => set({ enabled: v === "default" ? undefined : v === "on" })}
                  />
                )}
              </Field>
              <Field label="Content-Security-Policy">
                {() => (
                  <Segmented
                    label="Content-Security-Policy"
                    value={override.csp ?? "default"}
                    options={[
                      { value: "default", label: "Default" },
                      { value: "enforce", label: "Enforce" },
                      { value: "report-only", label: "Report only" },
                      { value: "off", label: "Off" },
                    ]}
                    onChange={(v) => set({ csp: v === "default" ? undefined : (v as Override["csp"]) })}
                  />
                )}
              </Field>
              <Field label="Framing (X-Frame-Options)">
                {(id) => (
                  <select id={id} value={override.frameOptions === undefined ? "" : String(override.frameOptions)} onChange={(e) => set({ frameOptions: e.target.value === "" ? undefined : e.target.value === "false" ? false : (e.target.value as "DENY" | "SAMEORIGIN") })}>
                    <option value="">Default</option>
                    <option value="DENY">DENY: never in a frame</option>
                    <option value="SAMEORIGIN">SAMEORIGIN: only in this site's frames</option>
                    <option value="false">Not sent</option>
                  </select>
                )}
              </Field>
              <Field label="HSTS" hint="Sent over https only; tells browsers to use https for a year">
                {(id) => (
                  <select
                    id={id}
                    value={override.hsts === undefined ? "" : override.hsts === false ? "off" : override.hsts.includeSubDomains ? (override.hsts.preload ? "preload" : "subdomains") : "on"}
                    onChange={(e) => {
                      const v = e.target.value;
                      set({ hsts: v === "" ? undefined : v === "off" ? false : { maxAge: 31_536_000, includeSubDomains: v !== "on", preload: v === "preload" } });
                    }}
                  >
                    <option value="">Default</option>
                    <option value="on">This host, 1 year</option>
                    <option value="subdomains">With subdomains</option>
                    <option value="preload">With subdomains, preload</option>
                    <option value="off">Not sent</option>
                  </select>
                )}
              </Field>
              <Field label="Cross-Origin-Resource-Policy">
                {(id) => (
                  <select id={id} value={override.crossOriginResourcePolicy === undefined ? "" : String(override.crossOriginResourcePolicy)} onChange={(e) => set({ crossOriginResourcePolicy: e.target.value === "" ? undefined : e.target.value === "false" ? false : (e.target.value as "same-origin") })}>
                    <option value="">Default</option>
                    <option value="same-origin">same-origin</option>
                    <option value="same-site">same-site</option>
                    <option value="cross-origin">cross-origin</option>
                    <option value="false">Not sent</option>
                  </select>
                )}
              </Field>
              <Field label="Referrer-Policy">
                {(id) => (
                  <select id={id} value={override.referrerPolicy === undefined ? "" : String(override.referrerPolicy)} onChange={(e) => set({ referrerPolicy: e.target.value === "" ? undefined : e.target.value === "false" ? false : e.target.value })}>
                    <option value="">Default</option>
                    {REFERRERS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                    <option value="false">Not sent</option>
                  </select>
                )}
              </Field>
            </div>
            <div className="field">
              <label htmlFor={`src-${s.surface}`}>Allow more sources</label>
              <div className="chips-row" role="list" aria-label="Added sources">
                {Object.entries(override.add ?? {}).flatMap(([dir, list]) =>
                  list.map((v) => (
                    <span key={`${dir} ${v}`} role="listitem" className="chip" style={{ borderStyle: "solid" }}>
                      <code>{dir}</code> {v}
                      <button type="button" className="sec-x" aria-label={`Remove ${v} from ${dir}`} onClick={() => removeSource(dir, v)}>
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  )),
                )}
                {!Object.keys(override.add ?? {}).length && <span className="muted small">None: the preset as it is.</span>}
              </div>
              <form className="toolbar-row" style={{ marginTop: "0.4rem" }} onSubmit={(e) => (e.preventDefault(), addSource())}>
                <select aria-label="Directive" value={directive} onChange={(e) => setDirective(e.target.value)} style={{ width: "auto" }}>
                  {DIRECTIVES.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <input id={`src-${s.surface}`} value={source} placeholder="https://cdn.example.com" aria-invalid={bad} onChange={(e) => (setSource(e.target.value), setBad(false))} />
                <Button type="submit" variant="ghost">
                  Add
                </Button>
              </form>
              <small className={bad ? "bad" : "muted"}>
                {bad ? "A source is an origin (https://cdn.example.com), a host (*.example.com), a scheme (https:) or a keyword ('self')." : "For a CDN, an analytics or payment SDK, an image host: the browser loads from it only for that directive."}
              </small>
            </div>
          </>
        )}
        {s.headers.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Header</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {s.headers.map((h) => (
                  <tr key={h.name}>
                    <td>
                      <code className="field-name">{h.name}</code>
                    </td>
                    <td>
                      <code className="sec-value">{h.name.startsWith("content-security-policy") ? h.value.split(";").join(";\n") : h.value}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="lock">No security headers are sent here.</Empty>
        )}
        {editable && Object.keys(override).length > 0 && (
          <div className="toolbar-row">
            <span className="push" />
            <Button variant="ghost" onClick={() => onChange({})}>
              Back to the code's settings
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Reports({ d, admin, busy, onClear }: { d: Info; admin: Admin; busy: boolean; onClear: () => void }) {
  const [filter, setFilter] = useState("all");
  const shown = d.reports.filter((r) => filter === "all" || r.surface === filter);
  return (
    <section className="panel stack" aria-label="Content-Security-Policy reports">
      <div className="toolbar">
        <h3>What the policy blocked</h3>
        <span className="muted small">reports browsers sent to {d.reportPath ?? "nowhere"}, the latest 200 since this server started</span>
        <span className="push" />
        <Chips
          label="Surface"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: d.reports.length },
            { value: "app", label: "App pages", count: d.reports.filter((r) => r.surface === "app").length },
            { value: "dashboard", label: "Dashboard", count: d.reports.filter((r) => r.surface === "dashboard").length },
          ]}
        />
        {admin.role !== "viewer" && d.reports.length > 0 && (
          <Button variant="ghost" disabled={busy} onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
      {shown.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Page</th>
                <th scope="col">Directive</th>
                <th scope="col">Blocked</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  <td title={new Date(r.at).toLocaleString()}>
                    {clock(r.at)} <span className="muted small">{ago(r.at)}</span>
                  </td>
                  <td>
                    <code>{r.page || "?"}</code>
                  </td>
                  <td>
                    <code>{r.directive}</code>
                  </td>
                  <td>
                    <code>{r.blocked || "?"}</code>
                    {r.sample && <div className="muted small">{r.sample}</div>}
                  </td>
                  <td>
                    <Badge tone={r.disposition === "report" ? "warn" : "bad"}>{r.disposition === "report" ? "would block" : "blocked"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="lock">Nothing has been blocked. When something is (a script from a host the policy doesn't list, an inline script without the nonce), it shows here: allow its source above, or fix the page.</Empty>
      )}
    </section>
  );
}
