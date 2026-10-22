import { Component, StrictMode, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { get, login, logout, type Admin, type Manifest } from "./api";
import { Audit } from "./pages/Audit";
import { Data } from "./pages/Data";
import { Files } from "./pages/Files";
import { Functions } from "./pages/Functions";
import { Logs } from "./pages/Logs";
import { Metrics } from "./pages/Metrics";
import { Scheduled } from "./pages/Scheduled";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { Badge, Button, ErrorNote, Field, Spinner, ToastProvider, useAsync } from "./ui";

const PAGES = ["Data", "Functions", "Logs", "Metrics", "Scheduled", "Files", "Users", "Audit", "Settings"] as const;
type PageName = (typeof PAGES)[number];

type Theme = "system" | "light" | "dark";
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
  if (me.loading && me.data === undefined) return <Spinner label="Loading dashboard" />;
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
      <form className="panel stack" onSubmit={submit} aria-labelledby="login-title">
        <h1 id="login-title">archlast-forge</h1>
        <div className="toolbar" role="radiogroup" aria-label="Sign in with">
          <Button variant={mode === "account" ? "primary" : "ghost"} aria-pressed={mode === "account"} onClick={() => setMode("account")}>
            Admin account
          </Button>
          <Button variant={mode === "key" ? "primary" : "ghost"} aria-pressed={mode === "key"} onClick={() => setMode("key")}>
            Admin key
          </Button>
        </div>
        {mode === "account" ? (
          <>
            <Field label="Email">{(id) => <input id={id} name="email" type="email" autoComplete="username" required autoFocus />}</Field>
            <Field label="Password">{(id) => <input id={id} name="password" type="password" autoComplete="current-password" required />}</Field>
          </>
        ) : (
          <Field label="ADMIN_KEY" hint="`archlast-forge dev` prints it on startup.">
            {(id) => <input id={id} name="key" type="password" required autoFocus />}
          </Field>
        )}
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="muted small">
          Create accounts with <code>archlast-forge admin add you@example.com</code>.
        </p>
      </form>
    </main>
  );
}

function Shell({ admin, onSignOut }: { admin: Admin; onSignOut: () => void }) {
  const [page, setPage] = useState<PageName>(() => (PAGES.includes(location.hash.slice(1) as PageName) ? (location.hash.slice(1) as PageName) : "Data"));
  const [theme, setTheme] = useTheme();
  const manifest = useAsync(() => get<Manifest>("manifest"), [], { interval: 5000 });
  useEffect(() => {
    history.replaceState(null, "", `#${page}`);
    document.title = `${page} · archlast-forge`;
  }, [page]);
  useEffect(() => {
    // Alt+1…9 jumps between pages.
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (e.altKey && n >= 1 && n <= PAGES.length) {
        e.preventDefault();
        setPage(PAGES[n - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const m = manifest.data;
  useEffect(() => {
    if (manifest.error?.startsWith("Sign in")) onSignOut(); // session expired or revoked
  }, [manifest.error]);
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <strong className="brand">archlast-forge</strong>
        <span className="push" />
        <label className="theme">
          <span className="sr-only">Theme</span>
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label="Theme">
            <option value="system">System theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <span className="muted small">{admin.email}</span>
        <Badge tone="accent">{admin.role}</Badge>
        <Button variant="ghost" onClick={onSignOut}>
          Sign out
        </Button>
      </header>
      <nav className="sidebar" aria-label="Dashboard">
        {PAGES.map((p, i) => (
          <button key={p} aria-current={p === page ? "page" : undefined} onClick={() => setPage(p)} title={`Alt+${i + 1}`}>
            {p}
          </button>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>
        {m?.error && <p className="note error">The function runtime failed to load: {m.error}</p>}
        <ErrorNote error={manifest.error} />
        {!m ? (
          <Spinner />
        ) : (
          <Boundary key={page}>
            {page === "Data" && <Data manifest={m} admin={admin} />}
            {page === "Functions" && <Functions manifest={m} admin={admin} />}
            {page === "Logs" && <Logs manifest={m} />}
            {page === "Metrics" && <Metrics />}
            {page === "Scheduled" && <Scheduled admin={admin} />}
            {page === "Files" && <Files manifest={m} admin={admin} />}
            {page === "Users" && <Users admin={admin} />}
            {page === "Audit" && <Audit />}
            {page === "Settings" && <Settings manifest={m} admin={admin} />}
          </Boundary>
        )}
      </main>
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
