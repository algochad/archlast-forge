// What the app's MDX (forge/docs pages and slots) can use without importing anything: Callout, Tabs, Steps, Cards, CodeGroup, Accordion, and
// code blocks with a title (```ts title="server.ts"). Headings get ids, an anchor and a place in "On this page". The app's own components
// (forge/docs/_components) join them by name. Also the boundary that keeps a broken page or slot from taking the rest of the page down.
import { Children, Component, isValidElement, useEffect, useId, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { CopyButton } from "./code";
import { useT } from "./context";

/** The text inside some React children, for ids and copy buttons. */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

export const headingId = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-") || "section";

/** A heading of a page: an id from its text, an anchor beside it, and a place in "On this page" (levels 2 and 3). */
export function Heading({ level, id, children, className, toc = true, label }: { level: 2 | 3 | 4 | 5; id?: string; children: ReactNode; className?: string; toc?: boolean; label?: string }) {
  const t = useT();
  const H = `h${level}` as "h2";
  const key = id ?? headingId(textOf(children));
  return (
    <H id={key} className={className} data-toc={toc && level <= 3 ? level : undefined} data-toc-label={label} data-part="heading">
      {children}
      <a className="fd-anchor" href={`#${key}`} aria-label={t("linkToSection")}>
        #
      </a>
    </H>
  );
}

const shifted = (level: 2 | 3 | 4 | 5) => (props: { children?: ReactNode; id?: string }) => <Heading level={level} id={props.id}>{props.children}</Heading>;

// ---- callouts ----

const CALLOUT_KINDS = ["note", "info", "tip", "warning", "danger"] as const;
type CalloutKind = (typeof CALLOUT_KINDS)[number];

export function Callout({ type = "note", title, children }: { type?: CalloutKind; title?: string; children?: ReactNode }) {
  const kind = CALLOUT_KINDS.includes(type) ? type : "note";
  return (
    <aside className={`fd-callout fd-callout-${kind}`} data-part="callout" data-kind={kind} role={kind === "warning" || kind === "danger" ? "note" : undefined}>
      {title && <p className="fd-callout-title">{title}</p>}
      <div className="fd-callout-body">{children}</div>
    </aside>
  );
}
const calloutOf = (type: CalloutKind) => (props: { title?: string; children?: ReactNode }) => <Callout type={type} {...props} />;

// ---- tabs (the choice is remembered for tabs with the same labels, or the same `group`) ----

const storeKey = (group: string) => `forge-docs-tabs:${group}`;

export function Tab({ children }: { title: string; children?: ReactNode }) {
  return <>{children}</>;
}

export function Tabs({ children, group }: { children?: ReactNode; group?: string }) {
  const tabs = Children.toArray(children).filter(isValidElement) as ReactElement<{ title?: string; children?: ReactNode }>[];
  const titles = tabs.map((tab, i) => tab.props.title ?? String(i + 1));
  const key = storeKey(group ?? titles.join("|"));
  const [active, setActive] = useState(0);
  const id = useId();
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      const i = saved ? titles.indexOf(saved) : -1;
      if (i >= 0) setActive(i);
    } catch {
      // Not remembered.
    }
    const on = (e: StorageEvent | CustomEvent) => {
      const value = "detail" in e ? (e.detail as { key: string; value: string }) : { key: (e as StorageEvent).key ?? "", value: (e as StorageEvent).newValue ?? "" };
      const i = value.key === key ? titles.indexOf(value.value) : -1;
      if (i >= 0) setActive(i);
    };
    addEventListener("forge-docs-tab", on as EventListener);
    return () => removeEventListener("forge-docs-tab", on as EventListener);
  }, [key, titles.join("\u0000")]);
  const pick = (i: number) => {
    setActive(i);
    try {
      localStorage.setItem(key, titles[i]!);
    } catch {
      // Not remembered.
    }
    dispatchEvent(new CustomEvent("forge-docs-tab", { detail: { key, value: titles[i] } }));
  };
  return (
    <div className="fd-mdx-tabs" data-part="tabs">
      <div className="fd-tabs" role="tablist">
        {titles.map((title, i) => (
          <button type="button" role="tab" key={title + i} id={`${id}-t${i}`} aria-controls={`${id}-p${i}`} aria-selected={i === active} tabIndex={i === active ? 0 : -1} onClick={() => pick(i)}>
            {title}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div key={i} role="tabpanel" id={`${id}-p${i}`} aria-labelledby={`${id}-t${i}`} hidden={i !== active} className="fd-mdx-tabpanel">
          {tab.props.children}
        </div>
      ))}
    </div>
  );
}

// ---- steps, cards, accordions ----

export function Steps({ children }: { children?: ReactNode }) {
  return (
    <ol className="fd-mdx-steps" data-part="steps">
      {children}
    </ol>
  );
}
export function Step({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <li className="fd-mdx-step">
      {title && <p className="fd-mdx-step-title">{title}</p>}
      <div>{children}</div>
    </li>
  );
}

export function Cards({ children, cols }: { children?: ReactNode; cols?: number }) {
  return (
    <div className="fd-mdx-cards" data-part="cards" style={cols ? { gridTemplateColumns: `repeat(${Math.max(1, Math.min(4, cols))}, minmax(0, 1fr))` } : undefined}>
      {children}
    </div>
  );
}
export function Card({ title, href, icon, children }: { title?: string; href?: string; icon?: ReactNode; children?: ReactNode }) {
  const body = (
    <>
      {icon && <span className="fd-mdx-card-icon">{icon}</span>}
      {title && <span className="fd-mdx-card-title">{title}</span>}
      {children && <span className="fd-mdx-card-body">{children}</span>}
    </>
  );
  return href ? (
    <a className="fd-mdx-card" href={href} data-part="card">
      {body}
    </a>
  ) : (
    <div className="fd-mdx-card" data-part="card">
      {body}
    </div>
  );
}

export function Accordion({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children?: ReactNode }) {
  return (
    <details className="fd-mdx-accordion" open={defaultOpen} data-part="accordion">
      <summary>{title}</summary>
      <div className="fd-mdx-accordion-body">{children}</div>
    </details>
  );
}
export function AccordionGroup({ children }: { children?: ReactNode }) {
  return <div className="fd-mdx-accordions">{children}</div>;
}

// ---- code blocks: ```ts title="server.ts" ----

/** The title in a fenced block's meta: `title="server.ts"`, `title=server.ts`, or a bare file name. */
export function titleOfMeta(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  return /\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta)?.slice(1).find((x) => x !== undefined) ?? (/^[\w./-]+\.\w+$/.test(meta.trim()) ? meta.trim() : undefined);
}

const LANG_LABELS: Record<string, string> = { ts: "TS", tsx: "TSX", js: "JS", jsx: "JSX", json: "JSON", bash: "Shell", sh: "Shell", shell: "Shell", py: "Python", python: "Python", go: "Go", rb: "Ruby", ruby: "Ruby", php: "PHP", java: "Java", cs: "C#", csharp: "C#", http: "HTTP", yaml: "YAML", yml: "YAML", sql: "SQL", html: "HTML", css: "CSS", diff: "Diff" };

interface CodeInfo {
  lang?: string;
  title?: string;
  text: string;
  children: ReactNode;
}
function codeInfo(pre: ReactNode): CodeInfo | null {
  if (!isValidElement(pre)) return null;
  const code = (pre.props as { children?: ReactNode }).children;
  if (!isValidElement(code)) return { text: textOf(code), children: code };
  const p = code.props as { className?: string; "data-meta"?: string; children?: ReactNode };
  return { lang: /language-(\S+)/.exec(p.className ?? "")?.[1], title: titleOfMeta(p["data-meta"]), text: textOf(p.children), children: p.children };
}

/** A fenced code block: a head with its title (or language) and a copy button when it has a title, the code below. */
export function Pre(props: { children?: ReactNode }) {
  const info = codeInfo(<pre {...props} />);
  if (!info) return <pre {...props} />;
  const label = info.title ?? (info.lang ? LANG_LABELS[info.lang] ?? info.lang : undefined);
  return (
    <div className="fd-code fd-mdx-code" data-part="code-block" data-lang={info.lang}>
      {label && (
        <div className="fd-code-head">
          {info.title && info.lang && <span className="fd-mdx-lang">{LANG_LABELS[info.lang] ?? info.lang}</span>}
          <span className="fd-mdx-code-title">{label}</span>
          <span className="fd-code-actions">
            <CopyButton text={info.text} />
          </span>
        </div>
      )}
      <pre>
        <code className={info.lang ? `language-${info.lang}` : undefined}>{info.children}</code>
      </pre>
    </div>
  );
}

/** Code blocks as tabs, one per block, titled by their `title` (or language). */
export function CodeGroup({ children }: { children?: ReactNode }) {
  const blocks = Children.toArray(children)
    .map(codeInfo)
    .filter((b): b is CodeInfo => !!b);
  const [active, setActive] = useState(0);
  const id = useId();
  if (!blocks.length) return null;
  const current = blocks[Math.min(active, blocks.length - 1)]!;
  return (
    <div className="fd-code fd-mdx-code" data-part="code-group">
      <div className="fd-code-head">
        <div className="fd-tabs" role="tablist">
          {blocks.map((b, i) => (
            <button type="button" role="tab" key={i} id={`${id}-t${i}`} aria-selected={i === active} tabIndex={i === active ? 0 : -1} onClick={() => setActive(i)}>
              {b.title ?? (b.lang ? LANG_LABELS[b.lang] ?? b.lang : String(i + 1))}
            </button>
          ))}
        </div>
        <span className="fd-code-actions">
          <CopyButton text={current.text} />
        </span>
      </div>
      <pre role="tabpanel" aria-labelledby={`${id}-t${active}`}>
        <code className={current.lang ? `language-${current.lang}` : undefined}>{current.children}</code>
      </pre>
    </div>
  );
}

/** Everything MDX gets by name. The app's own components (forge/docs/_components) are added over these. */
export const MDX_COMPONENTS: Record<string, ComponentType<any>> = {
  h1: shifted(2),
  h2: shifted(2),
  h3: shifted(3),
  h4: shifted(4),
  h5: shifted(5),
  pre: Pre,
  Callout,
  Note: calloutOf("note"),
  Info: calloutOf("info"),
  Tip: calloutOf("tip"),
  Warning: calloutOf("warning"),
  Danger: calloutOf("danger"),
  Tabs,
  Tab,
  Steps,
  Step,
  Cards,
  Card,
  CodeGroup,
  Accordion,
  AccordionGroup,
};

// ---- errors in the app's MDX ----

/** What a page or slot that failed shows: in development the error, naming the file; in production nothing. */
export function ContentError({ file, message, dev }: { file: string; message: string; dev: boolean }) {
  const t = useT();
  if (!dev) return null;
  return (
    <div className="fd-content-error" role="alert" data-part="content-error">
      <p className="fd-content-error-title">{t("contentFailed", { file })}</p>
      <pre>{message}</pre>
    </div>
  );
}

/** Keeps an error while rendering a page or slot in it: the rest of the page goes on. */
export class ContentBoundary extends Component<{ file: string; dev: boolean; children?: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error(`The API docs page: ${this.props.file} failed while rendering: ${error.message}`);
  }
  override render() {
    return this.state.error ? <ContentError file={this.props.file} message={this.state.error.message} dev={this.props.dev} /> : this.props.children;
  }
}
