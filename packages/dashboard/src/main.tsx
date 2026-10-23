import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/space-grotesk";
import { Component, StrictMode, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { get, login, logout, type Admin, type Manifest } from "./api";
import { Avatar, Icon, Logo, Wordmark, type IconName } from "./brand";
import { Audit } from "./pages/Audit";
import { Data } from "./pages/Data";
import { Files } from "./pages/Files";
import { Functions } from "./pages/Functions";
import { Logs } from "./pages/Logs";
import { Cache } from "./pages/Cache";
import { Metrics } from "./pages/Metrics";
import { Overview } from "./pages/Overview";
import { Scheduled } from "./pages/Scheduled";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { Badge, Button, ErrorNote, Field, Skeleton, ToastProvider, useAsync } from "./ui";

const PAGES = {
  Overview: { icon: "overview", section: "Forge", blurb: "How your forge is running right now." },
  Data: { icon: "data", section: "Data", blurb: "Browse, filter and edit documents." },
  Files: { icon: "files", section: "Data", blurb: "Objects in storage, uploaded through presigned URLs." },
  Users: { icon: "users", section: "Data", blurb: "Accounts, sessions and bans." },
  Functions: { icon: "functions", section: "Runtime", blurb: "Run any function with typed arguments." },
  Scheduled: { icon: "scheduled", section: "Runtime", blurb: "Crons and scheduled jobs." },
  Logs: { icon: "logs", section: "Runtime", blurb: "Function calls and console output." },
  Metrics: { icon: "metrics", section: "Runtime", blurb: "Throughput, errors and latency over time." },
  Cache: { icon: "cache", section: "Runtime", blurb: "How much work the query cache is saving." },
  Audit: { icon: "audit", section: "Admin", blurb: "Every change made from this dashboard." },
  Settings: { icon: "settings", section: "Admin", blurb: "Schema, environment and live subscriptions." },
} satisfies Record<string, { icon: IconName; section: string; blurb: string }>;
type PageName = keyof typeof PAGES;
const PAGE_NAMES = Object.keys(PAGES) as PageName[];
const pageFromHash = (): PageName => (PAGE_NAMES.includes(location.hash.slice(1) as PageName) ? (location.hash.slice(1) as PageName) : "Overview");

type Theme = "system" | "light" | "dark";
const NEXT_THEME: Record<Theme, Theme> = { system: "dark", dark: "light", light: "system" };
const THEME_ICON: Record<Theme, IconName> = { system: "monitor", dark: "moon", light: "sun" };
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("afx:theme") as Theme) ?? "system");
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("afx:theme", theme);
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
  return <Shell admin={me.data} onSignOut={() => logout().then(me.reload)} />;
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
  const [page, setPage] = useState<PageName>(pageFromHash);
  const [visit, setVisit] = useState(0); // remounts the page when the palette jumps within it
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useTheme();
  const manifest = useAsync(() => get<Manifest>("manifest"), [], { interval: 5000 });
  const m = manifest.data;
  const open = (p: PageName) => {
    setPage(p);
    setVisit((v) => v + 1);
  };
  useEffect(() => {
    history.replaceState(null, "", `#${page}`);
    document.title = `${page} · archlast forge`;
  }, [page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      // Alt+1…9, Alt+0 jump between pages.
      const n = e.key === "0" ? 10 : Number(e.key);
      if (e.altKey && n >= 1 && n <= PAGE_NAMES.length) {
        e.preventDefault();
        open(PAGE_NAMES[n - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (manifest.error?.startsWith("Sign in")) onSignOut(); // session expired or revoked
  }, [manifest.error]);

  const sections = [...new Set(PAGE_NAMES.map((p) => PAGES[p].section))];
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Dashboard">
        <Wordmark />
        {sections.map((section) => (
          <div key={section} style={{ display: "contents" }}>
            <div className="nav-section">{section}</div>
            {PAGE_NAMES.filter((p) => PAGES[p].section === section).map((p) => {
              const n = PAGE_NAMES.indexOf(p) + 1;
              return (
                <button key={p} className="nav-item" aria-current={p === page ? "page" : undefined} onClick={() => open(p)}>
                  <Icon name={PAGES[p].icon} />
                  {p}
                  {n <= 10 && <kbd>⌥{n % 10}</kbd>}
                </button>
              );
            })}
          </div>
        ))}
        <div className="sidebar-foot" aria-label="Runtime status">
          <span>
            <span className={`status-dot ${m && !m.error ? "live" : "bad"}`} /> {m ? (m.error ? "Runtime down" : "Runtime healthy") : "Connecting…"}
          </span>
          {m && (
            <span className="muted">
              {m.functions.length} functions · {Object.keys(m.tables).length} tables
            </span>
          )}
        </div>
      </nav>
      <div className="column">
        <header className="topbar">
          <div className="page-title">
            <h1>{page}</h1>
            <p>{PAGES[page].blurb}</p>
          </div>
          <span className="push" />
          <button className="search-trigger" onClick={() => setPalette(true)} aria-label="Search (Ctrl+K)">
            <Icon name="search" size={16} />
            <span>Jump to…</span>
            <kbd>⌘K</kbd>
          </button>
          <Button variant="ghost" className="icon-only" onClick={() => setTheme(NEXT_THEME[theme])} aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`} title={`Theme: ${theme}`}>
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
          {m?.error && page !== "Overview" && <p className="note error">The function runtime failed to load: {m.error}</p>}
          <ErrorNote error={manifest.error} />
          {!m ? (
            <div className="panel">
              <Skeleton rows={6} />
            </div>
          ) : (
            <Boundary key={`${page}:${visit}`}>
              {page === "Overview" && <Overview manifest={m} onOpen={open} />}
              {page === "Data" && <Data manifest={m} admin={admin} />}
              {page === "Functions" && <Functions manifest={m} admin={admin} />}
              {page === "Logs" && <Logs manifest={m} />}
              {page === "Metrics" && <Metrics />}
              {page === "Cache" && <Cache admin={admin} />}
              {page === "Scheduled" && <Scheduled admin={admin} />}
              {page === "Files" && <Files manifest={m} admin={admin} />}
              {page === "Users" && <Users admin={admin} />}
              {page === "Audit" && <Audit />}
              {page === "Settings" && <Settings manifest={m} admin={admin} />}
            </Boundary>
          )}
        </main>
      </div>
      {palette && <Palette manifest={m} onClose={() => setPalette(false)} onOpen={open} />}
    </div>
  );
}

type Item = { label: string; hint: string; icon: IconName; go: () => void };

/** Ctrl/Cmd+K: jump to a page, a table or a function. */
function Palette({ manifest, onClose, onOpen }: { manifest?: Manifest; onClose: () => void; onOpen: (p: PageName) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...PAGE_NAMES.map((p) => ({ label: p, hint: "page", icon: PAGES[p].icon, go: () => onOpen(p) })),
      ...Object.keys(manifest?.tables ?? {}).map((t) => ({
        label: t,
        hint: "table",
        icon: "data" as IconName,
        go: () => (localStorage.setItem("afx:table", t), onOpen("Data")),
      })),
      ...(manifest?.functions ?? []).map((f) => ({
        label: f.name,
        hint: `${f.kind}${f.visibility === "internal" ? " · internal" : ""}`,
        icon: "functions" as IconName,
        go: () => (localStorage.setItem("afx:fn", f.name), onOpen("Functions")),
      })),
    ];
    const q = query.trim().toLowerCase();
    return (q ? all.filter((i) => i.label.toLowerCase().includes(q) || i.hint.includes(q)) : all).slice(0, 40);
  }, [query, manifest]);
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
            placeholder="Jump to a page, table or function…"
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
            <li key={`${item.hint}:${item.label}`} id={`palette-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}>
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
