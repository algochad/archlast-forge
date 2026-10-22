import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

// ---- data loading ----

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { interval?: number; enabled?: boolean } = {}) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback(async () => {
    try {
      const data = await fnRef.current();
      setState({ data, loading: false });
    } catch (e) {
      setState((s) => ({ ...s, error: (e as Error).message, loading: false }));
    }
  }, []);
  useEffect(() => {
    if (opts.enabled === false) return;
    setState((s) => ({ ...s, loading: true }));
    void load();
    if (!opts.interval) return;
    const t = setInterval(load, opts.interval);
    return () => clearInterval(t);
  }, [...deps, opts.interval, opts.enabled]);
  return { ...state, reload: load };
}

// ---- toasts ----

type Toast = { id: number; message: string; kind: "ok" | "error" };
const ToastContext = createContext<(message: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: Toast["kind"] = "ok") => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Runs an action, toasting its outcome. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<{ ok: boolean; value?: T }> => {
      setBusy(true);
      try {
        const value = await fn();
        if (success) toast(success);
        return { ok: true, value };
      } catch (e) {
        toast((e as Error).message, "error");
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---- small pieces ----

export const Spinner = ({ label = "Loading" }: { label?: string }) => (
  <span className="spinner" role="progressbar" aria-label={label}>
    <span />
  </span>
);

export const ErrorNote = ({ error }: { error?: string }) => (error ? <p className="note error" role="alert">{error}</p> : null);

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function Button({ variant = "primary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  return <button type="button" {...props} className={`btn ${variant} ${props.className ?? ""}`} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "bad" | "warn" | "accent" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

export function Code({ value }: { value: unknown }) {
  return <code className="cell-code">{typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? "undefined"}</code>;
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

/** A JSON textarea that reports parse errors as you type. */
export function JsonEditor({ id, value, onChange, rows = 10 }: { id?: string; value: string; onChange: (v: string) => void; rows?: number }) {
  let error: string | undefined;
  try {
    JSON.parse(value || "null");
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <>
      <textarea id={id} className="code" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-invalid={Boolean(error)} />
      {error && <small className="bad">{error}</small>}
    </>
  );
}

/** Side panel; Escape closes it and focus returns to what opened it. */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

// ---- charts ----

export type Series = { name: string; values: (number | null)[]; color: string };

/** Minimal SVG line chart. The aria-label summarizes it for screen readers. */
export function LineChart({ title, series, labels, unit = "", height = 160 }: { title: string; series: Series[]; labels: string[]; unit?: string; height?: number }) {
  const width = 600;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = Math.max(1, ...all);
  const n = Math.max(1, labels.length - 1);
  const x = (i: number) => pad.l + (i / n) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  const path = (values: (number | null)[]) =>
    values.reduce((d, v, i) => (v === null ? d : `${d}${d === "" || values[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  const latest = series.map((s) => `${s.name} ${s.values.filter((v) => v !== null).at(-1) ?? "—"}${unit}`).join(", ");
  return (
    <figure className="chart">
      <figcaption>
        {title}
        <span className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} /> {s.name}
            </span>
          ))}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}. Latest: ${latest}`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={width - pad.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" className="axis">
              {max * f < 10 ? Number((max * f).toFixed(1)) : Math.round(max * f)}
              {unit}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % Math.ceil(labels.length / 6) === 0 ? (
            <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="axis">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} />
        ))}
      </svg>
    </figure>
  );
}
