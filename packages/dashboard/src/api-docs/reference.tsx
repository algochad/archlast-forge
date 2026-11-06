// The API reference as one component: the page's shell (navigation, search, tabs, theme, the Authorize panel, "On this page", a place for the
// request builder to fail) around the current page of the docs (site.ts). The standalone page (app.tsx, rendered on the server by ssr.tsx)
// and the component for full-stack apps (react.tsx) are both this, so what is rendered here must work on a server too: nothing reads
// `window` or `document` while rendering, only in effects and event handlers.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { MDX_COMPONENTS } from "./components";
import type { CodeSampleLanguage, DocsPageConfig, DocsToken, ExplorerInstance } from "./contract";
import { DocProvider, Store, useDocSafe, type DocContext, type Guide, type Slots } from "./context";
import { CredentialStore, fetchToken, absoluteUrl, useCredentials } from "./credentials";
import { markdownUrl } from "./export";
import { loadExplorer, prefetchExplorer, resolveTheme } from "./explorer";
import { buildIndex, buildNav, Nav, search, SearchResults, type Here } from "./nav";
import { OperationView } from "./operation";
import { arrange, deref, serverUrlOf, type OpEntry, type OpenApi } from "./openapi";
import { Authentication, GuideView, Intro, Models, TagHeader, TagIndex, Webhooks } from "./sections";
import { buildSite, hrefOf, neighbours, type DocPage, type Site, type Target } from "./site";
import { makeTranslate, type Translate } from "./strings";

const AuthorizeDialog = lazy(() => import("./authorize"));

export interface ReferenceProps {
  /** The OpenAPI document, when the caller has it (rendered at once, also on a server). Otherwise it is fetched from `openapiUrl`. */
  document?: OpenApi;
  openapiUrl?: string;
  config?: DocsPageConfig;
  /** Where the page is as the browser sees it; links start with it, and it keys the stored credentials. */
  publicBase?: string;
  /** The page shown first, below `publicBase` ("" for the overview): what the server rendered. Default: the browser's address. */
  path?: string;
  /** The request builder's script. Without it there is no "Try it". */
  explorerUrl?: string | null;
  /** Open the request builder as soon as the document is there (the explorer path, `?try`). */
  tryOpen?: boolean;
  /** Development: a switch between the public document and the complete one, and errors of the app's MDX shown in the page. */
  dev?: boolean;
  guides?: Guide[];
  /** A guide shown only when the document has `/rpc` paths (the engine's function API). */
  functionsGuide?: Guide;
  slots?: Slots;
  /** The app's own MDX components (forge/docs/_components), by name. */
  components?: Record<string, React.ComponentType<any>>;
  /** Inside another page: no URL changes, no page-level behaviour. */
  embed?: boolean;
  className?: string;
}

const EMPTY: DocsPageConfig = {};
const DEFAULT_LANGUAGES: CodeSampleLanguage[] = ["curl", "node", "python"];
const noop = () => () => {};
const originNow = () => location.origin;
const noOrigin = () => "";

/** The query string with `try` (and `op`) set or cleared: the address of an operation with its builder open. */
function searchWith(search: string, on: boolean) {
  const params = new URLSearchParams(search);
  params.delete("try");
  params.delete("op");
  let s = params.toString();
  if (on) s += `${s ? "&" : ""}try`;
  return s ? `?${s}` : "";
}

/** The document: the one given (for the audience the page started with), else fetched; the other audience, in development, is fetched. */
function useDocument(props: ReferenceProps, all: boolean) {
  const [initial] = useState(all);
  const given = props.document && all === initial ? props.document : undefined;
  const [fetched, setFetched] = useState<{ doc?: OpenApi; error?: string; all?: boolean }>({});
  const url = props.openapiUrl ? `${props.openapiUrl}${all ? `${props.openapiUrl.includes("?") ? "&" : "?"}audience=all` : ""}` : undefined;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (given || !url) return;
    const abort = new AbortController();
    fetch(url, { signal: abort.signal })
      .then((r) => (r.ok ? (r.json() as Promise<OpenApi>) : Promise.reject(new Error(`${r.status} ${r.statusText}`.trim()))))
      .then(
        (doc) => setFetched({ doc, all }),
        (e: Error) => e.name !== "AbortError" && setFetched((f) => ({ ...f, error: e.message })),
      );
    return () => abort.abort();
  }, [url, given, attempt, all]);
  const doc = given ?? (fetched.all === all ? fetched.doc : undefined);
  return { doc, error: doc ? undefined : fetched.error, retry: () => (setFetched({}), setAttempt((n) => n + 1)) };
}

let endSettling: (() => void) | undefined;
/**
 * Scrolls to an element and keeps it there while the page settles: sections that are skipped until they come near (content-visibility) and
 * content that is still loading change the height of what is above it. It stops when the visitor scrolls or a moment has passed.
 */
function settleOn(root: HTMLElement | null, id: string) {
  endSettling?.();
  const target = () => {
    const el = document.getElementById(id);
    return el && root?.contains(el) ? el : null;
  };
  if (!target()) return;
  const go = () => target()?.scrollIntoView();
  go();
  const main = root?.querySelector("[data-part='content']");
  if (!main || typeof ResizeObserver === "undefined") return;
  const resize = new ResizeObserver(go);
  resize.observe(main);
  const events = ["wheel", "touchstart", "keydown", "mousedown"];
  const end = () => {
    resize.disconnect();
    clearTimeout(timer);
    for (const e of events) removeEventListener(e, end);
    if (endSettling === end) endSettling = undefined;
  };
  const timer = setTimeout(end, 2000);
  for (const e of events) addEventListener(e, end, { passive: true });
  endSettling = end;
}

const TOKEN_VARS: Record<DocsToken, string> = {
  bg: "--fd-bg",
  surface: "--fd-soft",
  text: "--fd-text",
  muted: "--fd-muted",
  faint: "--fd-faint",
  border: "--fd-border",
  borderStrong: "--fd-border-strong",
  accent: "--fd-accent",
  accentFill: "--fd-fill",
  codeBg: "--fd-code-bg",
  inlineCodeBg: "--fd-inline-bg",
  ok: "--fd-ok",
  warn: "--fd-warn",
  err: "--fd-err",
  synKey: "--fd-syn-key",
  synStr: "--fd-syn-str",
  synNum: "--fd-syn-num",
  synLit: "--fd-syn-lit",
};

/** The theme's settings as custom properties on the component. */
function themeStyle(theme: NonNullable<DocsPageConfig["theme"]>): CSSProperties {
  const style: Record<string, string> = {};
  if (theme.accent) style["--fd-accent"] = style["--fd-fill"] = theme.accent;
  if (theme.font) style["--fd-sans"] = theme.font;
  if (theme.monoFont) style["--fd-mono"] = theme.monoFont;
  if (theme.radius) style["--fd-r"] = theme.radius;
  if (theme.sidebarWidth) style["--fd-side-w"] = theme.sidebarWidth;
  for (const [name, value] of Object.entries(theme.tokens ?? {}) as [DocsToken, string | { light: string; dark: string }][]) {
    const v = TOKEN_VARS[name];
    if (!v || !value) continue;
    style[v] = typeof value === "string" ? value : `light-dark(${value.light}, ${value.dark})`;
  }
  return style as CSSProperties;
}

/** The page config with its defaults, for the shell. */
function resolveConfig(config: DocsPageConfig, embed: boolean) {
  const shell = config.layout?.shell ?? "sidebar";
  const theme = config.theme ?? {};
  const mode = theme.mode ?? (theme.preset === "dark" ? "dark" : "auto");
  const toggle = config.controls?.themeToggle;
  const toggleable = mode === "auto" && toggle !== false;
  const toggleStyle = typeof toggle === "string" ? toggle : ((toggle || undefined)?.style ?? "icon");
  const togglePlace = typeof toggle === "object" && toggle?.place ? toggle.place : shell === "sidebar" ? "sidebar" : "header";
  return {
    shell,
    mode,
    pages: config.layout?.pages ?? (embed ? "single" : "operation"),
    toc: config.layout?.toc !== false,
    actions: config.layout?.pageActions === false ? [] : (config.layout?.pageActions ?? (embed ? [] : ["copy", "markdown"])),
    pagination: config.layout?.pagination !== false,
    breadcrumbs: config.layout?.breadcrumbs !== false,
    authorize: config.controls?.authorize ?? "header",
    toggleable,
    toggleStyle,
    togglePlace,
    devSwitch: config.controls?.devSwitch !== false,
    download: config.hide?.downloadLink ? false : (config.controls?.download ?? (shell === "sidebar" ? "sidebar" : "header")),
    collapsible: config.nav?.groups?.collapsible !== false,
    upper: config.nav?.groups?.case === "upper",
  };
}

function SunMoon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg className="fd-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg className="fd-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** The headings of the page now shown, for "On this page" (levels 2 and 3 marked `data-toc`). */
function useToc(root: HTMLElement | null, key: string) {
  const [items, setItems] = useState<{ id: string; text: string; level: number }[]>([]);
  useEffect(() => {
    const content = root?.querySelector("[data-part='content']");
    if (!content) return;
    const read = () => {
      const found = [...content.querySelectorAll<HTMLElement>("[data-toc][id]")].map((h) => ({ id: h.id, text: h.dataset.tocLabel ?? (h.textContent ?? "").replace(/#$/, "").trim(), level: Number(h.dataset.toc) }));
      setItems((old) => (JSON.stringify(old) === JSON.stringify(found) ? old : found));
    };
    read();
    // Guides load after the page: read again when the content changes.
    const watch = typeof MutationObserver === "undefined" ? null : new MutationObserver(read);
    watch?.observe(content, { childList: true, subtree: true });
    return () => watch?.disconnect();
  }, [root, key]);
  return items;
}

function Toc({ items, active, t }: { items: { id: string; text: string; level: number }[]; active: string | null; t: Translate }) {
  if (!items.length) return null;
  return (
    <nav className="fd-toc" aria-label={t("onThisPage")} data-part="toc">
      <p className="fd-toc-title">{t("onThisPage")}</p>
      <ul>
        {items.map((it) => (
          <li key={it.id} data-level={it.level}>
            <a href={`#${encodeURIComponent(it.id).replace(/%2F/g, "/")}`} aria-current={active === it.id ? "location" : undefined}>
              {it.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function PageActions({ page, actions, publicBase, t }: { page: DocPage; actions: string[]; publicBase: string; t: Translate }) {
  const [state, setState] = useState<"" | "copied" | "failed">("");
  if (!actions.length) return null;
  const url = markdownUrl(publicBase, { page: page.path });
  const copy = async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      await navigator.clipboard.writeText(await r.text());
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState(""), 1500);
  };
  return (
    <div className="fd-page-actions" data-part="page-actions">
      {actions.includes("copy") && (
        <button type="button" className="fd-btn fd-btn-ghost" onClick={copy} data-part="copy-page">
          {state === "copied" ? t("pageCopied") : t("copyPage")}
          <span className="fd-sr" role="status">
            {state === "copied" ? t("pageCopied") : ""}
          </span>
        </button>
      )}
      {actions.includes("markdown") && (
        <a className="fd-btn fd-btn-ghost" href={url} data-part="view-markdown" data-native="">
          {t("viewMarkdown")}
        </a>
      )}
    </div>
  );
}

function Pagination({ site, page, withinArea, publicBase, t }: { site: Site; page: DocPage; withinArea: boolean; publicBase: string; t: Translate }) {
  const { previous, next } = neighbours(site, page, withinArea);
  if (!previous && !next) return null;
  return (
    <nav className="fd-pagination" aria-label={`${t("previous")} / ${t("next")}`} data-part="pagination">
      {previous ? (
        <a href={hrefOf(publicBase, { page: previous.path, anchor: "" })} rel="prev" data-dir="prev">
          <span>{t("previous")}</span>
          <strong>{previous.title}</strong>
        </a>
      ) : (
        <span />
      )}
      {next && (
        <a href={hrefOf(publicBase, { page: next.path, anchor: "" })} rel="next" data-dir="next">
          <span>{t("next")}</span>
          <strong>{next.title}</strong>
        </a>
      )}
    </nav>
  );
}

/** The content of one page of the site. */
function PageContent({ page, guides }: { page: DocPage; guides: Guide[] }) {
  const ctx = useDocSafe();
  if (!ctx) return null;
  const { model, site, config } = ctx;
  switch (page.kind) {
    case "overview":
      return (
        <>
          <Intro />
          <Authentication />
        </>
      );
    case "guide": {
      const g = guides.find((x) => x.slug === page.guide!.slug);
      return g ? <GuideView guide={g} asPage /> : null;
    }
    case "tag":
      return (
        <section className="fd-section" data-part="tag">
          <TagHeader section={page.tag!} asTitle />
          {site.mode === "tag" ? page.tag!.ops.map((o) => <OperationView key={o.id} entry={o} />) : <TagIndex section={page.tag!} />}
        </section>
      );
    case "operation":
      return <OperationView entry={page.op!} asPage />;
    case "webhooks":
      return <Webhooks events={model.webhooks} asTitle />;
    case "models":
      return <Models models={model.models} asTitle />;
    case "single":
      return (
        <>
          <Intro />
          {guides.map((g) => (
            <GuideView key={g.slug} guide={g} />
          ))}
          <Authentication />
          {model.groups.map((group, gi) => (
            <div className="fd-group" key={gi}>
              {group.tags.map((section) => (
                <section className="fd-section" id={site.tag.get(section)?.anchor} data-spy={site.tag.get(section)?.anchor} key={section.id} data-part="tag">
                  <TagHeader section={section} />
                  {section.ops.map((o) => (
                    <OperationView key={o.id} entry={o} />
                  ))}
                </section>
              ))}
            </div>
          ))}
          {!config.hide?.webhooks && <Webhooks events={model.webhooks} />}
          {!config.hide?.models && <Models models={model.models} />}
        </>
      );
  }
}

export function Reference(props: ReferenceProps) {
  const config = props.config ?? EMPTY;
  const embed = !!props.embed;
  const dev = !!props.dev;
  const publicBase = props.publicBase ?? "";
  const r = useMemo(() => resolveConfig(config, embed), [config, embed]);
  const t = useMemo(() => makeTranslate(config.strings), [config.strings]);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [all, setAll] = useState(() => dev && typeof location !== "undefined" && new URLSearchParams(location.search).get("audience") === "all");
  const { doc, error, retry } = useDocument(props, all);
  const model = useMemo(() => (doc ? arrange(doc, t("untagged"), t("otherGroup")) : null), [doc, t]);
  const origin = useSyncExternalStore(noop, originNow, noOrigin);

  const guides = useMemo(() => [...(props.guides ?? []), ...(model?.hasRpc && props.functionsGuide ? [props.functionsGuide] : [])], [props.guides, props.functionsGuide, model?.hasRpc]);
  const hide = config.hide ?? {};
  const site = useMemo(
    () =>
      model
        ? buildSite(model, guides, {
            pages: r.pages,
            referencePath: config.layout?.referencePath,
            hide,
            labels: { overview: t("overview"), guides: t("guides"), webhooks: t("webhooks"), models: t("models"), api: t("api") },
          })
        : null,
    [model, guides, r.pages, config.layout?.referencePath, hide.models, hide.webhooks, t],
  );
  const languages = config.codeSamples?.languages?.length ? config.codeSamples.languages : DEFAULT_LANGUAGES;
  const tryEnabled = !!props.explorerUrl && config.explorer !== false;
  const preset = config.explorer === false ? undefined : config.explorer?.auth;

  // Where the visitor is: the page, and the section of it in view.
  const [here, setHere] = useState<Here>(() => ({ page: props.path ?? (embed || typeof location === "undefined" ? "" : location.pathname.slice(publicBase.length).replace(/\/+$/, "")), anchor: null }));
  const page = site?.byPath.get(here.page) ?? null;

  // Credentials: one store for the Authorize panel and the request builder.
  const [credentials] = useState(() => new CredentialStore(config.credentials ?? "session", `forge-docs:${publicBase}:${props.openapiUrl ?? ""}`));
  const creds = useCredentials(credentials);
  const [lang] = useState(() => new Store<string | undefined>(undefined));
  useEffect(() => {
    try {
      const saved = localStorage.getItem("forge-docs-lang");
      if (saved) lang.set(saved);
    } catch {
      // Not remembered.
    }
    return lang.subscribe(() => {
      try {
        if (lang.get()) localStorage.setItem("forge-docs-lang", lang.get()!);
      } catch {
        // Not remembered.
      }
    });
  }, [lang]);

  // An OAuth2 token is fetched again shortly before it ends, for as long as the client is kept.
  useEffect(() => {
    if (!doc) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [name, c] of Object.entries(creds)) {
      if (c.type !== "oauth2" || !c.accessToken || !c.expiresAt || !c.clientId || !c.clientSecret) continue;
      const flow = deref(doc, doc.components?.securitySchemes?.[name])?.flows?.clientCredentials;
      if (!flow?.tokenUrl && !preset?.oauth2?.tokenUrl) continue;
      const tokenUrl = absoluteUrl(preset?.oauth2?.tokenUrl ?? flow?.tokenUrl ?? "", serverUrlOf(doc, undefined, origin));
      timers.push(
        setTimeout(
          () => {
            fetchToken({ tokenUrl, clientId: c.clientId!, clientSecret: c.clientSecret!, scopes: c.scopes ?? [], extra: preset?.oauth2?.extraParams }).then(
              (res) => credentials.update(name, { ...c, ...res }),
              () => {},
            );
          },
          Math.min(2 ** 31 - 1, Math.max(1000, c.expiresAt - Date.now() - 30_000)),
        ),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [creds, doc, preset, origin, credentials]);

  // Theme.
  const [mode, setMode] = useState<"auto" | "light" | "dark">(r.mode);
  const [system, setSystem] = useState<"light" | "dark">("light");
  useEffect(() => {
    const q = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystem(q.matches ? "dark" : "light");
    on();
    q.addEventListener("change", on);
    if (r.toggleable)
      try {
        const saved = localStorage.getItem("forge-docs-theme");
        if (saved === "light" || saved === "dark") setMode(saved);
      } catch {
        // Follows the system.
      }
    return () => q.removeEventListener("change", on);
  }, [r.toggleable]);
  const resolved = mode === "auto" ? system : mode;
  const toggleTheme = () => {
    const nextMode = resolved === "dark" ? "light" : "dark";
    setMode(nextMode);
    try {
      localStorage.setItem("forge-docs-theme", nextMode);
    } catch {
      // Not remembered.
    }
  };
  const theme = config.theme ?? {};
  const style = useMemo(() => themeStyle(theme), [theme]);

  // The request builder: Scalar's modal, a fixed overlay with its own list of operations. It is mounted into a plain element at the end of <body>,
  // outside this component, so that no ancestor's transform or filter can contain it. It tells the page when the visitor closes it.
  const [failed, setFailed] = useState<{ entry: OpEntry; error: string } | null>(null);
  const instance = useRef<ExplorerInstance | null>(null);
  const hostEl = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const live = useRef({ doc, creds, languages, preset, config });
  live.current = { doc, creds, languages, preset, config };
  const syncUrl = useCallback(
    (on: boolean) => {
      if (embed) return;
      try {
        history.replaceState(history.state, "", `${location.pathname}${searchWith(location.search, on)}${location.hash}`);
      } catch {
        // The address stays as it is.
      }
    },
    [embed],
  );
  const openBuilder = useCallback(
    async (entry: OpEntry, from: HTMLElement | null) => {
      if (!props.explorerUrl || !live.current.doc || !rootRef.current) return;
      opener.current = from ?? opener.current;
      setFailed(null);
      syncUrl(true);
      try {
        const explorer = await loadExplorer(props.explorerUrl);
        const l = live.current;
        if (!instance.current) {
          const el = (hostEl.current = document.createElement("div"));
          el.className = "forge-docs-explorer";
          document.body.append(el);
          instance.current = explorer.mount(el, {
            document: l.doc!,
            baseServerUrl: location.origin,
            theme: resolveTheme(rootRef.current, rootRef.current.dataset.mode === "dark" ? "dark" : "light"),
            auth: l.preset,
            credentials: l.creds,
            onCredentials: (c) => credentials.set(c),
            codeSamples: l.languages,
            // The builder's texts are Scalar's, under their own keys (`apiClient.requestBlock.requestBody`); the page's keys are for the page.
            strings: Object.fromEntries(Object.entries(l.config.strings ?? {}).filter(([k]) => k.startsWith("apiClient."))),
          });
          instance.current.onClose = () => {
            syncUrl(false);
            opener.current?.focus({ preventScroll: true });
          };
        }
        instance.current.open({ path: entry.path, method: entry.method });
      } catch (e) {
        syncUrl(false);
        setFailed({ entry, error: (e as Error).message });
      }
    },
    [props.explorerUrl, credentials, syncUrl],
  );
  useEffect(
    () => () => {
      instance.current?.destroy();
      instance.current = null;
      hostEl.current?.remove();
      hostEl.current = null;
    },
    [],
  );
  useEffect(() => {
    instance.current?.update({ credentials: creds });
  }, [creds]);
  useEffect(() => {
    if (doc) instance.current?.update({ document: doc });
  }, [doc]);
  useEffect(() => {
    const el = rootRef.current;
    if (!instance.current || !el) return;
    const frame = requestAnimationFrame(() => instance.current?.update({ theme: resolveTheme(el, resolved) }));
    return () => cancelAnimationFrame(frame);
  }, [resolved, theme.accent, theme.font, theme.monoFont, theme.radius, theme.tokens]);

  // Going to a page or an anchor without leaving the page: the address changes (history), the content and the navigation follow.
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const scrollTo = useRef<string | null>(null);
  const allNow = useRef(all);
  allNow.current = all;
  const go = useCallback(
    (target: Target, push: boolean) => {
      setMenu(false);
      setQuery("");
      setHere({ page: target.page, anchor: target.anchor || null });
      scrollTo.current = target.anchor || "";
      if (embed) return;
      // The complete document (development's switch) stays on as the visitor moves.
      const url = `${publicBase}${target.page}${allNow.current ? "?audience=all" : ""}${target.anchor ? `#${encodeURIComponent(target.anchor).replace(/%2F/g, "/")}` : ""}`;
      try {
        if (push) history.pushState(null, "", url);
        else history.replaceState(null, "", url);
      } catch {
        // The address stays as it is.
      }
    },
    [embed, publicBase],
  );
  useLayoutEffect(() => {
    const anchor = scrollTo.current;
    if (anchor === null) return;
    scrollTo.current = null;
    if (anchor) settleOn(rootRef.current, anchor);
    else if (!embed) scrollTo0();
    else rootRef.current?.scrollIntoView({ block: "start" });
  }, [here, embed]);
  const onLinkClick = useCallback(
    (e: MouseEvent) => {
      if (!site || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target || a.hasAttribute("download") || a.dataset.native !== undefined) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      const anchor = decodeURIComponent(url.hash.slice(1));
      // A link to a section of this page, or one of 0.19's (`#/payments/createPayment`, in descriptions written then) to where it is now.
      if (url.pathname === location.pathname && url.search === location.search && url.hash) {
        e.preventDefault();
        go(anchor.startsWith("/") && site.legacy.has(anchor) ? site.legacy.get(anchor)! : { page: here.page, anchor }, true);
        return;
      }
      if (url.pathname !== publicBase && !url.pathname.startsWith(`${publicBase}/`)) return;
      const target = url.pathname.slice(publicBase.length).replace(/\/+$/, "");
      if (!site.byPath.has(target)) return;
      e.preventDefault();
      go({ page: target, anchor }, true);
    },
    [site, here.page, publicBase, go],
  );
  // The browser's back and forward.
  useEffect(() => {
    if (embed) return;
    const on = () => {
      setHere({ page: location.pathname.slice(publicBase.length).replace(/\/+$/, ""), anchor: decodeURIComponent(location.hash.slice(1)) || null });
      scrollTo.current = decodeURIComponent(location.hash.slice(1));
    };
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, [embed, publicBase]);

  // Where the address points when the page starts: an old #/… link moves to its page, an anchor is scrolled to, and the builder opens if asked.
  const started = useRef(false);
  useEffect(() => {
    if (!model || !site || started.current) return;
    started.current = true;
    const hash = decodeURIComponent(location.hash.slice(1));
    const old = hash.startsWith("/") ? site.legacy.get(hash) : undefined;
    if (!embed && old) go(old, false);
    else if (hash) {
      setHere((h) => ({ ...h, anchor: hash }));
      settleOn(rootRef.current, hash);
    }
    const params = new URLSearchParams(location.search);
    const wanted = params.get("op");
    const byOp = !embed && wanted ? model.ops.find((o) => o.operationId === wanted) : undefined;
    if (byOp && !old) go(site.op.get(byOp)!, false);
    if (tryEnabled && !embed && (props.tryOpen || params.has("try"))) {
      const entry = byOp ?? (page?.op ? page.op : undefined) ?? model.ops.find((o) => o.id === hash) ?? model.ops[0];
      if (entry) void openBuilder(entry, null);
    }
  }, [model, site, embed, tryEnabled, props.tryOpen, openBuilder, go, page]);

  // The section in view, for the navigation and "On this page".
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !page || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
        let best: Element | null = null;
        for (const el of visible) if (!best || best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
        const id = (best as HTMLElement | null)?.dataset.spy || (best as HTMLElement | null)?.id || null;
        setActive(id);
      },
      { rootMargin: "-12% 0px -80% 0px" },
    );
    const watch = () => root.querySelectorAll("[data-part='content'] [data-spy], [data-part='content'] [data-toc][id]").forEach((el) => io.observe(el));
    watch();
    const later = setTimeout(watch, 300);
    return () => (io.disconnect(), clearTimeout(later));
  }, [page, guides.length]);
  const tocItems = useToc(rootRef.current, `${here.page}|${!!doc}`);

  useEffect(() => {
    if (embed || !doc) return;
    const name = config.title ?? doc.info.title;
    document.title = page && page.kind !== "overview" && page.kind !== "single" ? `${page.title} | ${name}` : name;
  }, [embed, doc, config.title, page]);

  // Ready: rendered in the browser and listening (what the server sent is now the page's own).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  // Search.
  const [authorizing, setAuthorizing] = useState(false);
  const [shortcut, setShortcut] = useState("⌘K");
  useEffect(() => setShortcut(/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"), []);
  const nav = useMemo(() => (model && site ? buildNav(site, model, guides, hide, t) : []), [site, model, guides, hide.models, hide.webhooks, t]);
  const index = useMemo(() => (model && site ? buildIndex(site, model, guides, hide, t) : []), [site, model, guides, hide.models, hide.webhooks, t]);
  const results = useMemo(() => search(index, query), [index, query]);
  useEffect(() => {
    if (hide.search) return;
    const on = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement | null)?.tagName ?? "") || (e.target as HTMLElement | null)?.isContentEditable;
      if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        setMenu(true);
        searchRef.current?.focus();
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [hide.search]);

  const href = useCallback((target: Target | null | undefined) => (target ? hrefOf(publicBase, target) : "#"), [publicBase]);
  const mdx = useMemo(() => ({ ...MDX_COMPONENTS, ...props.components }), [props.components]);
  const context = useMemo<DocContext | null>(
    () =>
      doc && model && site
        ? {
            doc,
            model,
            config,
            t,
            origin,
            openapiUrl: props.openapiUrl,
            languages,
            lang,
            slots: props.slots ?? {},
            credentials,
            preset,
            authorize: () => setAuthorizing(true),
            tryIt: { enabled: tryEnabled, open: (entry, from) => void openBuilder(entry, from), prefetch: () => props.explorerUrl && prefetchExplorer(props.explorerUrl) },
            site,
            publicBase,
            href,
            dev,
            mdx,
          }
        : null,
    [doc, model, site, config, t, origin, props.openapiUrl, languages, lang, props.slots, credentials, preset, tryEnabled, openBuilder, props.explorerUrl, publicBase, href, dev, mdx],
  );

  const Header = props.slots?.header;
  const SidebarFooter = props.slots?.["sidebar-footer"];
  const title = config.title ?? doc?.info.title ?? t("apiReference");
  const downloadUrl = props.openapiUrl && r.download !== false ? `${props.openapiUrl}${all ? `${props.openapiUrl.includes("?") ? "&" : "?"}audience=all` : ""}` : undefined;
  const hasSchemes = !!model && model.schemes.length > 0;

  // Tabs: sections of the site, and links.
  const tabs = (config.nav?.tabs ?? []).map((tab) => {
    if ("section" in tab) {
      const first = tab.section === "guides" ? site?.order.find((p) => p.area === "guides") : site?.byPath.get("");
      return { label: tab.label, href: first ? hrefOf(publicBase, { page: first.path, anchor: "" }) : "#", current: page?.area === tab.section, area: tab.section };
    }
    return { label: tab.label, href: tab.href, current: false, area: undefined };
  });
  const byArea = tabs.some((tb) => tb.area === "guides") && page ? page.area : null;
  const navGroups = byArea ? nav.filter((g) => g.area === byArea) : nav;

  // ---- the shell's pieces ----
  const brand = (
    <a className="fd-brand" href={config.logo?.href ?? hrefOf(publicBase, { page: "", anchor: "" })} data-part="brand">
      {config.logo && (
        <>
          <img className="fd-logo fd-logo-light" src={config.logo.url} alt={config.logo.alt ?? ""} />
          {config.logo.dark && <img className="fd-logo fd-logo-dark" src={config.logo.dark} alt={config.logo.alt ?? ""} />}
        </>
      )}
      {config.logo?.title !== false && <span>{title}</span>}
    </a>
  );
  const version = doc && config.logo?.title !== false && (
    <span className="fd-version" data-part="version">
      {doc.info.version}
    </span>
  );
  const authorizeButton = hasSchemes && (
    <button type="button" className="fd-btn" onClick={() => setAuthorizing(true)} data-set={Object.keys(creds).length ? "" : undefined} data-part="authorize">
      {t("authorize")}
      {Object.keys(creds).length > 0 && <span className="fd-dot" role="img" aria-label={t("credentialsSet")} />}
    </button>
  );
  const themeButton = r.toggleable && (
    <button type="button" className={`fd-btn${r.toggleStyle === "icon" ? " fd-btn-icon" : ""}`} onClick={toggleTheme} title={t("toggleTheme")} aria-label={t("toggleTheme")} data-part="theme-toggle">
      {r.toggleStyle === "icon" ? <SunMoon dark={resolved === "dark"} /> : resolved === "dark" ? t("light") : t("dark")}
    </button>
  );
  const devSwitch = dev && r.devSwitch && (
    <label className="fd-switch" title={t("showAllHint")} data-part="dev-switch">
      <input
        type="checkbox"
        checked={all}
        onChange={(e) => {
          setAll(e.target.checked);
          if (!embed) history.replaceState(null, "", `${location.pathname}${e.target.checked ? "?audience=all" : ""}${location.hash}`);
        }}
      />
      <span>{t("showAll")}</span>
    </label>
  );
  const download = downloadUrl && (
    <a className="fd-btn" href={downloadUrl} download="openapi.json" data-part="download">
      {t("openapiJson")}
    </a>
  );
  const searchBox = !hide.search && (
    <div className="fd-search" data-part="search">
      <input
        ref={searchRef}
        type="search"
        value={query}
        placeholder={t("searchPlaceholder")}
        aria-label={t("search")}
        aria-keyshortcuts="Control+K Meta+K /"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) go(results[0].target, true);
          else if (e.key === "Escape") setQuery("");
        }}
      />
      {!query && <kbd className="fd-kbd">{shortcut}</kbd>}
    </div>
  );
  const headerSlot = Header && (
    <div className="fd-slot fd-slot-header" data-part="slot-header">
      <Suspense fallback={null}>
        <Header />
      </Suspense>
    </div>
  );
  const menuButton = (
    <button type="button" className="fd-btn fd-menu" aria-expanded={menu} aria-controls="fd-side" onClick={() => setMenu(!menu)} data-part="menu">
      {t("menu")}
    </button>
  );
  const tabBar = tabs.length > 0 && (
    <nav className="fd-tabbar" aria-label={t("sections")} data-part="tabs">
      {tabs.map((tb, i) => (
        <a key={i} href={tb.href} aria-current={tb.current ? "page" : undefined}>
          {tb.label}
        </a>
      ))}
    </nav>
  );
  const footerLinks = config.nav?.footer?.length ? (
    <ul className="fd-side-links" data-part="footer-links">
      {config.nav.footer.map((l, i) => (
        <li key={i}>
          <a href={l.href} data-native="">
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  ) : null;
  const sideFooter = (footerLinks || SidebarFooter || (r.authorize === "sidebar" && authorizeButton) || (r.togglePlace === "sidebar" && themeButton) || (r.download === "sidebar" && download)) && (
    <div className="fd-side-footer" data-part="sidebar-footer">
      {footerLinks}
      {SidebarFooter && (
        <div className="fd-slot fd-slot-footer">
          <Suspense fallback={null}>
            <SidebarFooter />
          </Suspense>
        </div>
      )}
      <div className="fd-side-footer-row">
        {r.download === "sidebar" && download}
        {r.authorize === "sidebar" && authorizeButton}
        {r.togglePlace === "sidebar" && themeButton}
      </div>
    </div>
  );
  const topActions = (
    <div className="fd-top-actions" data-part="actions">
      {devSwitch}
      {r.download === "header" && download}
      {r.authorize === "header" && authorizeButton}
      {r.togglePlace === "header" && themeButton}
    </div>
  );
  const navigation = query.trim() ? (
    <SearchResults results={results} query={query.trim()} publicBase={publicBase} t={t} onNavigate={() => setMenu(false)} />
  ) : (
    <Nav groups={navGroups} here={{ page: here.page, anchor: active ?? here.anchor }} publicBase={publicBase} t={t} onNavigate={() => setMenu(false)} collapsible={r.collapsible} upper={r.upper} />
  );
  const sidebar = (
    <div className="fd-side" id="fd-side" data-open={menu ? "" : undefined} data-part="sidebar">
      {r.shell === "sidebar" && (
        <div className="fd-side-head">
          {brand}
          {version}
        </div>
      )}
      {searchBox}
      {navigation}
      {sideFooter}
    </div>
  );

  let body: ReactNode;
  if (!doc) {
    body = error ? (
      <div className="fd-state" role="alert">
        <p>{t("loadFailed", { error })}</p>
        <button type="button" className="fd-btn" onClick={retry}>
          {t("retry")}
        </button>
      </div>
    ) : (
      <p className="fd-state" role="status">
        {t("loading")}
      </p>
    );
  } else if (context && site && !page) {
    body = (
      <div className="fd-state" role="alert" data-part="not-found">
        <p>{t("notFound")}</p>
        <a href={hrefOf(publicBase, site.overview)}>{t("backToOverview")}</a>
      </div>
    );
  } else if (context && site && page) {
    const showToc = r.toc && page.kind !== "single";
    body = (
      <DocProvider value={context}>
        <div className="fd-page-grid" data-toc={showToc ? "" : undefined}>
          <article className="fd-article" data-part="article" data-kind={page.kind}>
            {(r.breadcrumbs || r.actions.length > 0) && page.kind !== "single" && (
              <div className="fd-page-head" data-part="page-head">
                {r.breadcrumbs && page.section && (
                  <p className="fd-breadcrumb" data-part="breadcrumb">
                    {page.section}
                  </p>
                )}
                <PageActions page={page} actions={r.actions} publicBase={publicBase} t={t} />
              </div>
            )}
            <PageContent page={page} guides={guides} />
            {r.pagination && page.kind !== "single" && <Pagination site={site} page={page} withinArea={!!byArea} publicBase={publicBase} t={t} />}
          </article>
          {showToc && (
            <aside className="fd-toc-col" data-part="toc-column">
              <Toc items={tocItems} active={active} t={t} />
            </aside>
          )}
        </div>
      </DocProvider>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`fd ${embed ? "fd-embed" : "fd-page"}${props.className ? ` ${props.className}` : ""}`}
      data-theme={mode === "auto" ? undefined : mode}
      data-mode={resolved}
      data-shell={r.shell}
      data-preset={theme.preset && theme.preset !== "default" ? theme.preset : undefined}
      data-code={theme.code && theme.code !== "auto" ? theme.code : undefined}
      data-pills={theme.pills ?? (theme.preset === "minimal" ? "tinted" : undefined)}
      data-density={theme.density === "compact" ? "compact" : undefined}
      data-part="root"
      data-ready={ready ? "" : undefined}
      style={style}
      onClick={onLinkClick}
    >
      <a
        className="fd-skip"
        href="#fd-main"
        data-native=""
        onClick={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
      >
        {t("skipToContent")}
      </a>
      {r.shell === "header" ? (
        <>
          <header className="fd-top" data-part="header">
            {menuButton}
            {brand}
            {version}
            {tabBar}
            {headerSlot}
            {topActions}
          </header>
          <div className="fd-layout">
            {sidebar}
            <button type="button" className="fd-scrim" tabIndex={-1} aria-hidden="true" data-open={menu ? "" : undefined} onClick={() => setMenu(false)} />
            <main className="fd-main" id="fd-main" ref={contentRef} tabIndex={-1} data-part="content">
              {body}
            </main>
          </div>
        </>
      ) : (
        <div className="fd-layout">
          {sidebar}
          <button type="button" className="fd-scrim" tabIndex={-1} aria-hidden="true" data-open={menu ? "" : undefined} onClick={() => setMenu(false)} />
          <div className="fd-column">
            <header className="fd-top" data-part="header">
              {menuButton}
              <span className="fd-top-brand">{brand}</span>
              {tabBar}
              {headerSlot}
              {topActions}
            </header>
            <main className="fd-main" id="fd-main" ref={contentRef} tabIndex={-1} data-part="content">
              {body}
            </main>
          </div>
        </div>
      )}
      {failed && (
        <div className="fd-toast" role="alert">
          <p>{t("builderFailed", { error: failed.error })}</p>
          <button type="button" className="fd-btn" onClick={() => void openBuilder(failed.entry, null)}>
            {t("retry")}
          </button>
          <button type="button" className="fd-btn fd-btn-ghost" onClick={() => setFailed(null)}>
            {t("close")}
          </button>
        </div>
      )}
      {authorizing && context && (
        <DocProvider value={context}>
          <Suspense fallback={null}>
            <AuthorizeDialog onClose={() => setAuthorizing(false)} />
          </Suspense>
        </DocProvider>
      )}
    </div>
  );
}

const scrollTo0 = () => window.scrollTo({ top: 0 });
