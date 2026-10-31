// The pieces observability pages are built from: the page head with the range and service controls, cards, headline numbers,
// tags for kinds, methods and statuses, and links between pages.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./brand";
import { useCountUp } from "./charts";
import { count, delta as deltaOf, pct, splitOperation, trendTone } from "./format";
import { PRESETS, useObs, useRange, type Preset } from "./obs";
import { href } from "./router";

export function PageHead({ title, blurb, icon, controls = true, actions }: { title: ReactNode; blurb?: ReactNode; icon?: IconName; controls?: boolean; actions?: ReactNode }) {
  return (
    <header className="page-head">
      {icon && (
        <span className="page-mark" aria-hidden="true">
          <Icon name={icon} size={22} />
        </span>
      )}
      <div className="page-head-text">
        <h2>{title}</h2>
        {blurb && <p>{blurb}</p>}
      </div>
      <span className="push" />
      {actions}
      {controls && <RangeControls />}
    </header>
  );
}

export function RangeControls() {
  const r = useRange();
  const services = useObs<{ service: string }[]>("services", {}, { live: false });
  const [custom, setCustom] = useState(false);
  const toInput = (t: number) => new Date(t - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return (
    <div className="range-controls">
      {(services.data?.length ?? 0) > 1 && (
        <select className="service-pick" value={r.service ?? ""} onChange={(e) => r.set({ service: e.target.value || undefined })} aria-label="Service">
          <option value="">All services</option>
          {services.data!.map((s) => (
            <option key={s.service} value={s.service}>
              {s.service}
            </option>
          ))}
        </select>
      )}
      <button type="button" className={`live-toggle${r.live && r.preset !== "custom" ? " on" : ""}`} aria-pressed={r.live && r.preset !== "custom"} onClick={() => r.set({ live: !r.live, ...(r.preset === "custom" && { preset: "1h" }) })} title="Refresh as new data arrives">
        <span className="live-dot" /> Live
      </button>
      <div className="range-seg" role="radiogroup" aria-label="Time range">
        {(Object.keys(PRESETS) as Preset[]).map((p) => (
          <button key={p} type="button" role="radio" aria-checked={r.preset === p} onClick={() => (setCustom(false), r.set({ preset: p }))}>
            {p.toUpperCase()}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={r.preset === "custom"} onClick={() => setCustom((c) => !c)} aria-label="Custom range" title="Custom range">
          <Icon name="calendar" size={15} />
        </button>
      </div>
      {custom && (
        <form
          className="range-custom"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const from = new Date(String(f.get("from"))).getTime();
            const to = new Date(String(f.get("to"))).getTime();
            if (from < to) r.set({ preset: "custom", from, to, live: false }), setCustom(false);
          }}
        >
          <label>
            From <input type="datetime-local" name="from" defaultValue={toInput(r.resolve().from)} required />
          </label>
          <label>
            To <input type="datetime-local" name="to" defaultValue={toInput(Math.min(Date.now(), r.resolve().to))} required />
          </label>
          <button className="btn primary" type="submit">
            Apply
          </button>
        </form>
      )}
    </div>
  );
}

export function Card({ title, extra, children, className, footer, id }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string; footer?: ReactNode; id?: string }) {
  return (
    <section className={`card ${className ?? ""}`} aria-label={typeof title === "string" ? title : undefined} id={id}>
      {(title || extra) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {extra && <div className="card-extra">{extra}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}

/** A change against the previous period of the same length; `upIsGood` says which way is the good one. */
export function Delta({ now, before, upIsGood = false, label = "vs previous period" }: { now: number; before: number | null | undefined; upIsGood?: boolean; label?: string }) {
  const d = deltaOf(now, before);
  if (d === null) return <span className="delta flat">no earlier data</span>;
  const tone = trendTone(d, upIsGood);
  return (
    <span className={`delta ${tone}`} title={label}>
      <Icon name={d > 0 ? "trend-up" : d < 0 ? "trend-down" : "minus"} size={14} />
      {d > 0 ? "+" : ""}
      {(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}% <span className="faint">{label}</span>
    </span>
  );
}

/** The number a card leads with, counting up when it changes. */
export function Headline({ value, unit, format = count, sub }: { value: number; unit?: ReactNode; format?: (v: number) => string; sub?: ReactNode }) {
  const shown = useCountUp(value);
  return (
    <div className="headline">
      <strong>
        {format(shown)}
        {unit && <small>{unit}</small>}
      </strong>
      {sub && <div className="headline-sub">{sub}</div>}
    </div>
  );
}

export const KindTag = ({ kind }: { kind: string }) => <span className={`kind-tag k-${kind}`}>{kind}</span>;

export function MethodTag({ method }: { method?: string | null }) {
  if (!method) return null;
  return <span className={`method m-${method.toLowerCase()}`}>{method}</span>;
}

export function StatusTag({ status }: { status: number }) {
  return <span className={`status-tag ${status >= 500 ? "bad" : status >= 400 ? "warn" : "ok"}`}>{status}</span>;
}

/** An operation's name, with an HTTP method shown as a tag and the route's parameters marked. */
export function OpName({ operation, kind }: { operation: string; kind?: string }) {
  const { method, path } = splitOperation(operation);
  return (
    <span className="op-name">
      {method ? <MethodTag method={method} /> : kind ? <KindTag kind={kind} /> : null}
      <code>
        {path.split(/(\/)/).map((seg, i) =>
          seg === "/" ? (
            <span key={i} className="op-sep">
              /
            </span>
          ) : seg.startsWith(":") || seg === "*" ? (
            <b key={i}>{seg}</b>
          ) : (
            <span key={i}>{seg}</span>
          ),
        )}
      </code>
    </span>
  );
}

export const opHref = (kind: string, operation: string) => href(kind === "job" || kind === "cron" || kind === "consumer" ? "jobs" : "requests", { kind, op: operation });
export const traceHref = (traceId: string) => href("trace", { id: traceId });
export const errorHref = (fingerprint: string) => href("errors", { fp: fingerprint });
export const userHref = (id: string) => href("users", { id });
export const spanHref = (type: string, name: string) => href("spans", { type, name });

export function TraceLink({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <a className="trace-link mono" href={traceHref(id)} title={id}>
      {children ?? `${id.slice(0, 8)}…`}
    </a>
  );
}

export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips-row" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className="chip" onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="chip-count">{count(o.count)}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = "Search…" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  const timer = useRef<Timer>(undefined);
  useEffect(() => setText(value), [value]);
  return (
    <label className="search-box">
      <Icon name="search" size={15} />
      <input
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onChange(e.target.value), 250);
        }}
      />
    </label>
  );
}

/** Sortable column headers: click to sort, again to flip. */
export function useSort<K extends string>(initial: K, dir: "asc" | "desc" = "desc") {
  const [sort, setSort] = useState<{ key: K; dir: "asc" | "desc" }>({ key: initial, dir });
  const th = (key: K, label: ReactNode, className?: string) => (
    <th scope="col" className={className} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="th-sort" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))}>
        {label}
        {sort.key === key && <Icon name={sort.dir === "asc" ? "chevron-up" : "chevron-down"} size={12} />}
      </button>
    </th>
  );
  const apply = <R,>(rows: R[], value: (r: R, key: K) => number | string) =>
    [...rows].sort((a, b) => {
      const x = value(a, sort.key);
      const y = value(b, sort.key);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.dir === "asc" ? c : -c;
    });
  return { sort, th, apply };
}

/** Pages of a client-side list. */
export function usePages<T>(rows: T[], size = 15) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  useEffect(() => {
    if (page >= pages) setPage(0);
  }, [pages, page]);
  const pager =
    pages > 1 ? (
      <div className="pager-row">
        <button type="button" className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
          <Icon name="chevron-left" size={14} /> Previous
        </button>
        <span className="muted small">
          Page {page + 1} of {pages}
        </span>
        <button type="button" className="btn ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
          Next <Icon name="chevron-right" size={14} />
        </button>
      </div>
    ) : null;
  return { rows: rows.slice(page * size, page * size + size), pager };
}

/** In place of a page or view that needs telemetry, on a server started with TELEMETRY=off. */
export function TelemetryOff() {
  return (
    <Callout icon="overview" title="Telemetry is off">
      This server was started with <code>TELEMETRY=off</code>, so it records no requests, traces, errors, logs or metrics. Remove the variable (or set it to <code>on</code>) and restart to see
      them here. Data, Files, Functions, Cache, Audit and Settings work without it, and so do the Accounts of Users, the queue of Jobs and the live stream of Logs.
    </Callout>
  );
}

export function Callout({ tone = "accent", icon = "bolt", title, children, actions }:{ tone?: "accent" | "bad" | "warn" | "ok"; icon?: IconName; title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <aside className={`callout ${tone}`}>
      <span className="callout-icon">
        <Icon name={icon} size={18} />
      </span>
      <div>
        <strong>{title}</strong>
        <div className="callout-body">{children}</div>
        {actions && <div className="callout-actions">{actions}</div>}
      </div>
    </aside>
  );
}

/** A few labelled numbers in a row: the detail pages' summary. */
export function Facts({ items }: { items: { label: ReactNode; value: ReactNode; tone?: "bad" | "warn" | "ok" }[] }) {
  return (
    <dl className="facts">
      {items.map((it, i) => (
        <div key={i}>
          <dt>{it.label}</dt>
          <dd className={it.tone}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const Rate = ({ value }: { value: number }) => <span className={value >= 0.05 ? "bad" : value >= 0.01 ? "warn-text" : undefined}>{pct(value)}</span>;

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a className="back-link" href={to}>
      <Icon name="chevron-left" size={14} /> {children}
    </a>
  );
}

export function Refreshing({ on }: { on: boolean }) {
  return <span className={`refreshing${on ? " on" : ""}`} aria-hidden={!on} />;
}
