import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { Component, StrictMode, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { get, login, logout, post, type Admin, type Manifest } from "./api";
import { Avatar, Icon, Logo, Wordmark, type IconName } from "./brand";
import { ago } from "./format";
import { PageHead, QuietRange, TelemetryOff } from "./kit";
import { RangeProvider, TelemetryOn, useObs } from "./obs";
import { Alerts } from "./pages/Alerts";
import { Audit } from "./pages/Audit";
import { Backups } from "./pages/Backups";
import { Cache } from "./pages/Cache";
import { Data } from "./pages/Data";
import { Errors } from "./pages/Errors";
import { Files } from "./pages/Files";
import { Functions } from "./pages/Functions";
import { Hotspots } from "./pages/Hotspots";
import { Jobs } from "./pages/Jobs";
import { Keys } from "./pages/Keys";
import { Logs } from "./pages/Logs";
import { ServiceMap } from "./pages/Map";
import { CustomMetrics } from "./pages/Metrics";
import { Overview } from "./pages/Overview";
import { Releases } from "./pages/Releases";
import { Requests } from "./pages/Requests";
import { Runtime } from "./pages/Runtime";
import { Services } from "./pages/Services";
import { Settings } from "./pages/Settings";
import { Slos } from "./pages/Slos";
import { Spans } from "./pages/Spans";
import { TraceView } from "./pages/Trace";
import { UsersPage } from "./pages/UsersPage";
import { href, navigate, useRoute } from "./router";
import { Badge, Button, ErrorNote, Field, Skeleton, ToastProvider, useAsync } from "./ui";

type PageDef = { label: string; icon: IconName; group?: string; blurb: string; observe?: boolean };

/** Pages whose content is requests: when the range holds none, say where the stored ones are (QuietRange). */
const HOLDS_REQUESTS = new Set(["overview", "requests", "errors", "users", "hotspots", "spans", "map", "releases", "cache"]);

/** Every page; those without a group are reached from other pages (a trace). Observability pages take the range controls. */
const PAGES: Record<string, PageDef> = {
  overview: { label: "Overview", icon: "overview", group: "Observe", observe: true, blurb: "How your forge and the services reporting to it are doing." },
  requests: { label: "Requests", icon: "requests", group: "Observe", observe: true, blurb: "Every call to a function, route and page: volume, latency and failures." },
  errors: { label: "Errors", icon: "errors", group: "Observe", observe: true, blurb: "Failures grouped into issues by the shape of their stack." },
  logs: { label: "Logs", icon: "logs", group: "Observe", observe: true, blurb: "What your code printed, tied to the request it ran in." },
  users: { label: "Users", icon: "users", group: "Observe", observe: true, blurb: "Accounts, and everything each one did." },
  jobs: { label: "Jobs", icon: "jobs", group: "Observe", observe: true, blurb: "Scheduled functions and crons: runs, failures and time in the queue." },
  spans: { label: "Spans", icon: "spans", group: "Performance", observe: true, blurb: "Queries, outbound calls and your own spans, across every request." },
  hotspots: { label: "Hotspots", icon: "hotspots", group: "Performance", observe: true, blurb: "Which code burns the time: modules, classes and dependencies by their own time." },
  map: { label: "Map", icon: "map", group: "Performance", observe: true, blurb: "How clients, services, queues and databases talk to each other." },
  runtime: { label: "Runtime", icon: "runtime", group: "Performance", observe: true, blurb: "CPU, memory and event loop of every process, with connections and cache." },
  releases: { label: "Releases", icon: "releases", group: "Performance", observe: true, blurb: "Each release against the 30 minutes of traffic before and after it." },
  slos: { label: "SLOs", icon: "slo", group: "Performance", observe: true, blurb: "Objectives over the traffic you already record, with their error budget and burn rate." },
  metrics: { label: "Metrics", icon: "metrics", group: "Performance", observe: true, blurb: "Counters, gauges and histograms your code and services report." },
  data: { label: "Data", icon: "data", group: "Backend", blurb: "Browse, filter and edit documents." },
  files: { label: "Files", icon: "files", group: "Backend", blurb: "Objects in storage, uploaded through presigned URLs." },
  functions: { label: "Functions", icon: "functions", group: "Backend", blurb: "Run any function with typed arguments, or write one on the spot." },
  cache: { label: "Cache", icon: "cache", group: "Backend", blurb: "How much work the query cache is saving." },
  services: { label: "Services", icon: "services", group: "Admin", observe: true, blurb: "This engine and every service sending it telemetry." },
  alerts: { label: "Alerts", icon: "alerts", group: "Admin", blurb: "Rules over your telemetry, and what they caught." },
  keys: { label: "Ingest keys", icon: "key", group: "Admin", blurb: "Keys other services send OpenTelemetry with." },
  backups: { label: "Backups", icon: "backups", group: "Admin", blurb: "Snapshots of the data, the function source and the files: on a schedule or now, to download or restore." },
  audit: { label: "Audit", icon: "audit", group: "Admin", blurb: "Every change made from this dashboard." },
  settings: { label: "Settings", icon: "settings", group: "Admin", blurb: "Everything the engine can be configured with, the functions' environment, the schema and live subscriptions." },
  trace: { label: "Trace", icon: "trace", blurb: "One request from end to end." },
};
const NAV = Object.keys(PAGES).filter((p) => PAGES[p]!.group);
const GROUPS = [...new Set(NAV.map((p) => PAGES[p]!.group!))];

type Theme = "system" | "light" | "dark";
const NEXT_THEME: Record<Theme, Theme> = { system: "dark", dark: "light", light: "system" };
const THEME_ICON: Record<Theme, IconName> = { system: "monitor", dark: "moon", light: "sun" };
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (stored("afx:theme") as Theme) ?? "system");
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    store("afx:theme", theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

function App() {
  const me = useAsync(() => get<Admin | null>("me"), []);
  if (me.loading && me.data === undefined)
    return (
      <div className="boot" role="progressbar" aria-label="Loading dashboard">
        <Logo size={56} />
      </div>
    );
  if (!me.data) return <Login onSignedIn={me.reload} />;
  return (
    <RangeProvider>
      <Shell admin={me.data} onSignOut={() => logout().then(me.reload)} />
    </RangeProvider>
  );
}

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"account" | "key">("account");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await login(mode === "key" ? { key: String(f.get("key")) } : { email: String(f.get("email")), password: String(f.get("password")) });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand">
          <Logo size={64} />
          <h1 id="login-title">
            archlast <span className="ember-text">forge</span>
          </h1>
          <p>Sign in to the admin console.</p>
        </div>
        <form className="panel stack" onSubmit={submit} aria-labelledby="login-title">
          <div className="segmented" role="radiogroup" aria-label="Sign in with">
            <button type="button" aria-pressed={mode === "account"} onClick={() => setMode("account")}>
              <Icon name="users" size={15} /> Admin account
            </button>
            <button type="button" aria-pressed={mode === "key"} onClick={() => setMode("key")}>
              <Icon name="key" size={15} /> Admin key
            </button>
          </div>
          {mode === "account" ? (
            <>
              <Field label="Email">{(id) => <input id={id} name="email" type="email" autoComplete="username" placeholder="you@example.com" required autoFocus />}</Field>
              <Field label="Password">{(id) => <input id={id} name="password" type="password" autoComplete="current-password" required />}</Field>
            </>
          ) : (
            <Field label="ADMIN_KEY" hint="`archlast-forge dev` prints it on startup.">
              {(id) => <input id={id} name="key" type="password" required autoFocus />}
            </Field>
          )}
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"} <Icon name="arrow" size={16} />
          </Button>
        </form>
        <p className="muted small" style={{ textAlign: "center", margin: 0 }}>
          Create accounts with <code>archlast-forge admin add you@example.com</code>
        </p>
      </div>
    </main>
  );
}

function Shell({ admin, onSignOut }: { admin: Admin; onSignOut: () => void }) {
  const route = useRoute();
  const page = PAGES[route.page] ? route.page : "overview";
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useTheme();
  const [collapsed, setCollapsed] = useState<string[]>(() => JSON.parse(stored("afx:nav") ?? "[]"));
  const manifest = useAsync(() => get<Manifest>("manifest"), [], { interval: 5000 });
  // Whether the server records telemetry; until it answers, pages wait rather than ask for what may not be there.
  const server = useAsync(() => get<{ telemetry?: boolean }>("server"), []);
  const telemetry = server.data ? server.data.telemetry !== false : server.error ? true : undefined;
  const errors = useObs<{ list: { state: string | null }[] }>("errors", telemetry ? { state: "open" } : null, { live: false });
  const m = manifest.data;
  const def = PAGES[page]!;
  useEffect(() => {
    document.title = `${def.label} · archlast forge`;
    document.getElementById("main")?.scrollTo?.(0, 0);
  }, [page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      // Alt+1…9, Alt+0 jump between the first ten pages.
      const n = e.key === "0" ? 10 : Number(e.key);
      if (e.altKey && n >= 1 && n <= Math.min(10, NAV.length)) {
        e.preventDefault();
        navigate(NAV[n - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (manifest.error?.startsWith("Sign in")) onSignOut(); // session expired or revoked
  }, [manifest.error]);
  const toggleGroup = (g: string) => {
    const next = collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g];
    setCollapsed(next);
    store("afx:nav", JSON.stringify(next));
  };
  const openErrors = errors.data?.list.length ?? 0;

  return (
    <TelemetryOn.Provider value={telemetry === true}>
      <div className="shell">
        <a className="skip" href="#main">
          Skip to content
        </a>
        <nav className="sidebar" aria-label="Dashboard">
          <a href={href("overview")} className="plain-link">
            <Wordmark />
          </a>
          <div className="sidebar-scroll">
            {GROUPS.map((group) => (
              <div key={group} style={{ display: "contents" }}>
                <button type="button" className="nav-group-toggle" aria-expanded={!collapsed.includes(group)} onClick={() => toggleGroup(group)}>
                  {group}
                  <Icon name="chevron-down" size={12} />
                </button>
                {!collapsed.includes(group) &&
                  NAV.filter((p) => PAGES[p]!.group === group).map((p) => {
                    const n = NAV.indexOf(p) + 1;
                    return (
                      <a key={p} className="nav-item" href={href(p)} aria-current={p === page || (page === "trace" && p === "requests") ? "page" : undefined}>
                        <Icon name={PAGES[p]!.icon} />
                        {PAGES[p]!.label}
                        {p === "errors" && openErrors > 0 ? <span className="nav-count">{openErrors > 99 ? "99+" : openErrors}</span> : n <= 10 && <kbd>⌥{n % 10}</kbd>}
                      </a>
                    );
                  })}
              </div>
            ))}
          </div>
          <div className="sidebar-foot" aria-label="Runtime status">
            <span>
              <span className={`status-dot ${m && !m.error ? "live" : "bad"}`} /> {m ? (m.error ? "Runtime down" : "Runtime healthy") : "Connecting…"}
            </span>
            {m && (
              <span className="muted">
                {m.functions.length} functions · {Object.keys(m.tables).length} tables{m.release ? ` · ${m.release}` : ""}
              </span>
            )}
          </div>
        </nav>
        <div className="column">
          <header className="topbar">
            <div className="crumbs-top">
              <span className="faint">{def.group ?? "Observe"}</span>
              <Icon name="chevron-right" size={12} />
              <strong>{def.label}</strong>
            </div>
            <span className="push" />
            <button className="search-trigger" onClick={() => setPalette(true)} aria-label="Search (Ctrl+K)">
              <Icon name="search" size={16} />
              <span>Search or jump to…</span>
              <kbd>⌘K</kbd>
            </button>
            {telemetry && <Notifications />}
            <Button
              variant="ghost"
              className="icon-only"
              onClick={() => setTheme(NEXT_THEME[theme])}
              aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`}
              title={`Theme: ${theme}`}
            >
              <Icon name={THEME_ICON[theme]} />
            </Button>
            <div className="user-chip">
              <Avatar email={admin.email} />
              <span className="who">
                <span>{admin.email === "admin-key" ? "Admin key" : admin.email}</span>
                <Badge tone="accent">{admin.role}</Badge>
              </span>
              <Button variant="ghost" className="icon-only" onClick={onSignOut} aria-label="Sign out" title="Sign out">
                <Icon name="logout" size={16} />
              </Button>
            </div>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            <PageHead title={def.label} blurb={def.blurb} icon={def.icon} controls={(Boolean(def.observe) || page === "cache") && telemetry !== false} />
            {telemetry === true && HOLDS_REQUESTS.has(page) && <QuietRange />}
            {m?.error && <p className="note error">The function runtime failed to load: {m.error}</p>}
            <ErrorNote error={manifest.error} />
            <Boundary key={`${page}:${route.params.toString()}`}>
              {def.observe || page === "trace" || page === "alerts" || page === "keys" ? (
                telemetry === undefined ? (
                  <div className="panel">
                    <Skeleton rows={6} />
                  </div>
                ) : telemetry || ["users", "jobs", "logs"].includes(page) ? (
                  // Users, Jobs and Logs have a view that works without telemetry, and open on it.
                  <ObservePage page={page} params={route.params} manifest={m} admin={admin} />
                ) : (
                  <TelemetryOff />
                )
              ) : !m ? (
                <div className="panel">
                  <Skeleton rows={6} />
                </div>
              ) : (
                <>
                  {page === "data" && <Data manifest={m} admin={admin} />}
                  {page === "functions" && <Functions manifest={m} admin={admin} />}
                  {page === "cache" && <Cache admin={admin} />}
                  {page === "files" && <Files manifest={m} admin={admin} />}
                  {page === "audit" && <Audit />}
                  {page === "backups" && <Backups admin={admin} />}
                  {page === "settings" && <Settings manifest={m} admin={admin} />}
                </>
              )}
            </Boundary>
          </main>
        </div>
        {palette && <Palette manifest={m} telemetry={telemetry !== false} onClose={() => setPalette(false)} />}
      </div>
    </TelemetryOn.Provider>
  );
}

function ObservePage({ page, params, manifest, admin }: { page: string; params: URLSearchParams; manifest?: Manifest; admin: Admin }) {
  switch (page) {
    case "overview":
      return <Overview />;
    case "requests":
      return <Requests params={params} />;
    case "trace":
      return <TraceView id={params.get("id") ?? ""} />;
    case "errors":
      return <Errors params={params} admin={admin} />;
    case "logs":
      return <Logs params={params} />;
    case "users":
      return <UsersPage params={params} admin={admin} />;
    case "jobs":
      return <Jobs params={params} admin={admin} />;
    case "spans":
      return <Spans params={params} />;
    case "hotspots":
      return <Hotspots />;
    case "map":
      return <ServiceMap />;
    case "runtime":
      return <Runtime />;
    case "releases":
      return <Releases />;
    case "slos":
      return <Slos admin={admin} />;
    case "metrics":
      return <CustomMetrics />;
    case "services":
      return <Services manifest={manifest} />;
    case "alerts":
      return <Alerts admin={admin} />;
    case "keys":
      return <Keys admin={admin} />;
  }
  return null;
}

type Notice = {
  unseen: number;
  firing: { id: string; name: string; since: number; value: number | null; threshold: number; comparator: string; metric: string }[];
  recent: { id: string; rule_name: string; time: number; state: string; message: string }[];
};

function Notifications() {
  const [open, setOpen] = useState(false);
  const n = useAsync(() => get<Notice>("obs.notifications"), [], { interval: 30_000 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const count = (n.data?.unseen ?? 0) + (n.data?.firing.length ?? 0) ? Math.max(n.data!.unseen, n.data!.firing.length) : 0;
  return (
    <div className="bell" ref={ref}>
      <Button variant="ghost" className="icon-only" aria-label={`Notifications${count ? `: ${count} new` : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="alerts" />
      </Button>
      {count > 0 && <span className="count">{count > 9 ? "9+" : count}</span>}
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <header>
            <strong>Notifications</strong>
            <span className="push" />
            {(n.data?.unseen ?? 0) > 0 && (
              <button className="link small" onClick={() => post("obs.markSeen").then(n.reload)}>
                Mark all read
              </button>
            )}
            <a className="link small" href={href("alerts")} onClick={() => setOpen(false)}>
              Alerts →
            </a>
          </header>
          <ul>
            {n.data?.firing.map((f) => (
              <li key={f.id} className="firing">
                <strong>
                  <Icon name="errors" size={13} /> {f.name} is firing
                </strong>
                <span className="muted">since {ago(f.since)}</span>
              </li>
            ))}
            {n.data?.recent.map((e) => (
              <li key={e.id}>
                <span>{e.message}</span>
                <span className="faint small">
                  {e.state} · {ago(e.time)}
                </span>
              </li>
            ))}
            {!n.data?.firing.length && !n.data?.recent.length && <li className="muted">Nothing yet. Alert rules post here when they fire.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

type Item = { label: string; hint: string; icon: IconName; go: () => void };
type Found = {
  operations: { kind: string; operation: string }[];
  errors: { fingerprint: string; type: string; message: string }[];
  users: { user_id: string; user_name: string | null }[];
  traces: { trace_id: string; operation: string }[];
};

/** Ctrl/Cmd+K: jump to a page, a table, a function, or what telemetry knows (operations, errors, users, a trace id). */
function Palette({ manifest, telemetry, onClose }: { manifest?: Manifest; telemetry: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !telemetry) return setFound(null);
    const t = setTimeout(() => get<Found>("obs.search", { q }).then(setFound, () => setFound(null)), 150);
    return () => clearTimeout(t);
  }, [query, telemetry]);
  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...Object.keys(PAGES)
        .filter((p) => PAGES[p]!.group)
        .map((p) => ({ label: PAGES[p]!.label, hint: "page", icon: PAGES[p]!.icon, go: () => navigate(p) })),
      ...Object.keys(manifest?.tables ?? {}).map((t) => ({ label: t, hint: "table", icon: "data" as IconName, go: () => (store("afx:table", t), navigate("data")) })),
      ...(manifest?.functions ?? []).map((f) => ({
        label: f.name,
        hint: `${f.kind}${f.visibility === "internal" ? " · internal" : ""}`,
        icon: "functions" as IconName,
        go: () => (store("afx:fn", f.name), navigate("functions")),
      })),
    ];
    const q = query.trim().toLowerCase();
    const local = q ? all.filter((i) => i.label.toLowerCase().includes(q) || i.hint.includes(q)) : all;
    const remote: Item[] = found
      ? [
          ...found.traces.map((t) => ({ label: `${t.trace_id.slice(0, 12)}… ${t.operation}`, hint: "trace", icon: "trace" as IconName, go: () => navigate("trace", { id: t.trace_id }) })),
          ...found.operations.map((o) => ({
            label: o.operation,
            hint: `${o.kind} requests`,
            icon: "requests" as IconName,
            go: () => navigate(["job", "cron", "consumer"].includes(o.kind) ? "jobs" : "requests", { kind: o.kind, op: o.operation }),
          })),
          ...found.errors.map((e) => ({ label: `${e.type}: ${e.message}`.slice(0, 90), hint: "error", icon: "errors" as IconName, go: () => navigate("errors", { fp: e.fingerprint }) })),
          ...found.users.map((u) => ({ label: u.user_name ?? u.user_id, hint: "user", icon: "user" as IconName, go: () => navigate("users", { id: u.user_id }) })),
        ]
      : [];
    return [...local.slice(0, 30), ...remote].slice(0, 50);
  }, [query, manifest, found]);
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const choose = (i: Item | undefined) => {
    if (!i) return;
    i.go();
    onClose();
  };
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Jump to" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            placeholder="Pages, tables, functions, operations, errors, users or a trace id…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={`palette-${active}`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, items.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
              else if (e.key === "Enter") choose(items[active]);
              else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <ul id="palette-list" role="listbox" ref={listRef}>
          {items.map((item, i) => (
            <li key={`${item.hint}:${item.label}:${i}`} id={`palette-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}>
              <Icon name={item.icon} size={16} />
              <span className="mono">{item.label}</span>
              <span className="muted">{item.hint}</span>
            </li>
          ))}
          {!items.length && <li aria-disabled="true">No matches</li>}
        </ul>
        <footer>
          <span>
            <span className="kbd">↑↓</span> move
          </span>
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">esc</span> close
          </span>
        </footer>
      </div>
    </div>
  );
}

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? <p className="note error">This page crashed: {this.state.error.message}</p> : this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
