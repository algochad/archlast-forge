// Code blocks: tabs, a copy button, and colours for JSON.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "./context";

/** JSON text with its keys, strings and numbers wrapped, so the stylesheet can colour them. */
export function Json({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const cls = m[1] ? (m[2] ? "fd-k" : "fd-s") : m[3] ? "fd-l" : "fd-n";
    out.push(
      <span className={cls} key={m.index}>
        {m[1] ?? m[3] ?? m[4]}
      </span>,
    );
    if (m[2]) out.push(m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className="fd-btn fd-btn-ghost fd-copy" onClick={copy}>
      {done ? t("copied") : t("copy")}
      <span className="fd-sr" role="status">
        {done ? t("copied") : ""}
      </span>
    </button>
  );
}

export interface Tab {
  id: string;
  label: string;
  content: ReactNode;
  /** What the copy button copies; none hides it. */
  text?: string;
}

/** A code block with a header of tabs (or a title) and a copy button. */
export function CodeBox({ tabs, active, onTab, title, actions, label }: { tabs: Tab[]; active?: string; onTab?: (id: string) => void; title?: ReactNode; actions?: ReactNode; label: string }) {
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const base = useId();
  if (!current) return null;
  const move = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length]!;
    onTab?.(next.id);
    document.getElementById(`${base}-${next.id}`)?.focus();
  };
  return (
    <div className="fd-code">
      <div className="fd-code-head">
        {title && <span className="fd-code-title">{title}</span>}
        {tabs.length > 1 || !title ? (
          <div role="tablist" aria-label={label} className="fd-tabs">
            {tabs.map((tab, i) => (
              <button
                key={tab.id}
                id={`${base}-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={tab.id === current.id}
                aria-controls={`${base}-panel`}
                tabIndex={tab.id === current.id ? 0 : -1}
                onClick={() => onTab?.(tab.id)}
                onKeyDown={(e) => move(e, i)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : null}
        <span className="fd-code-actions">
          {actions}
          {current.text !== undefined && <CopyButton text={current.text} />}
        </span>
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-${current.id}`} tabIndex={0}>
        {current.content}
      </div>
    </div>
  );
}

export const Pre = ({ children }: { children: ReactNode }) => (
  <pre>
    <code>{children}</code>
  </pre>
);
