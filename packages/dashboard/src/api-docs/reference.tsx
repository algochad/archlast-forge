// The API reference as one component: the page's shell (header, navigation, search, theme, the Authorize panel, a place for the request builder to fail)
// around the document's sections. The standalone page (app.tsx) and the component for full-stack apps (react.tsx) are both this, so what is
// rendered here must work on a server too: nothing reads `window` or `document` while rendering, only in effects and event handlers.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { CodeSampleLanguage, DocsPageConfig, ExplorerInstance } from "./contract";
import { DocProvider, Store, type DocContext, type Guide, type Slots } from "./context";
import { CredentialStore, fetchToken, absoluteUrl, useCredentials } from "./credentials";
import { loadExplorer, prefetchExplorer, resolveTheme } from "./explorer";
import { buildIndex, buildNav, guideGroups, Nav, search, SearchResults } from "./nav";
import { OperationView } from "./operation";
import { arrange, deref, serverUrlOf, type OpEntry, type OpenApi } from "./openapi";
import { Authentication, GuideView, Intro, Models, TagHeader, Webhooks } from "./sections";
import { makeTranslate } from "./strings";

const AuthorizeDialog = lazy(() => import("./authorize"));

export interface ReferenceProps {
  /** The OpenAPI document, when the caller has it (rendered at once, also on a server). Otherwise it is fetched from `openapiUrl`. */
  document?: OpenApi;
  openapiUrl?: string;
  config?: DocsPageConfig;
  /** Where the page is as the browser sees it; keys the stored credentials. */
  publicBase?: string;
  /** The request builder's script. Without it there is no "Try it". */
  explorerUrl?: string | null;
  /** Open the request builder as soon as the document is there (the explorer path, `?try`). */
  tryOpen?: boolean;
  /** Development: a switch between the public document and the complete one. */
  dev?: boolean;
  guides?: Guide[];
  /** A guide shown only when the document has `/rpc` paths (the engine's function API). */
  functionsGuide?: Guide;
  slots?: Slots;
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

function useDocument(props: ReferenceProps, all: boolean) {
  const [fetched, setFetched] = useState<{ doc?: OpenApi; error?: string }>({});
  const url = props.openapiUrl ? `${props.openapiUrl}${all ? `${props.openapiUrl.includes("?") ? "&" : "?"}audience=all` : ""}` : undefined;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (props.document || !url) return;
    const abort = new AbortController();
    fetch(url, { signal: abort.signal })
      .then((r) => (r.ok ? (r.json() as Promise<OpenApi>) : Promise.reject(new Error(`${r.status} ${r.statusText}`.trim()))))
      .then(
        (doc) => setFetched({ doc }),
        (e: Error) => e.name !== "AbortError" && setFetched((f) => ({ ...f, error: e.message })),
      );
    return () => abort.abort();
  }, [url, props.document, attempt]);
  return { doc: props.document ?? fetched.doc, error: props.document ? undefined : fetched.error, retry: () => (setFetched({}), setAttempt((n) => n + 1)) };
}

let endSettling: (() => void) | undefined;
/**
 * Scrolls to a section and keeps it there while the page settles: sections that are skipped until they come near (content-visibility) and
 * guides that are still loading change the height of what is above it. It stops when the visitor scrolls or a moment has passed.
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
  const main = document.getElementById("fd-main");
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

export function Reference(props: ReferenceProps) {
  const config = props.config ?? EMPTY;
  const embed = !!props.embed;
  const t = useMemo(() => makeTranslate(config.strings), [config.strings]);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [all, setAll] = useState(() => !!props.dev && typeof location !== "undefined" && new URLSearchParams(location.search).get("audience") === "all");
  const { doc, error, retry } = useDocument(props, all);
  const model = useMemo(() => (doc ? arrange(doc, t("untagged"), t("otherGroup")) : null), [doc, t]);
  const origin = useSyncExternalStore(noop, originNow, noOrigin);

  const guides = useMemo(() => [...(props.guides ?? []), ...(model?.hasRpc && props.functionsGuide ? [props.functionsGuide] : [])], [props.guides, props.functionsGuide, model?.hasRpc]);
  const hide = config.hide ?? {};
  const languages = config.codeSamples?.languages?.length ? config.codeSamples.languages : DEFAULT_LANGUAGES;
  const tryEnabled = !!props.explorerUrl && config.explorer !== false;
  const preset = config.explorer === false ? undefined : config.explorer?.auth;

  // Credentials: one store for the Authorize panel and the request builder.
  const [credentials] = useState(() => new CredentialStore(config.credentials ?? "session", `forge-docs:${props.publicBase ?? ""}:${props.openapiUrl ?? ""}`));
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
              (r) => credentials.update(name, { ...c, ...r }),
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
  const [mode, setMode] = useState<"auto" | "light" | "dark">(config.theme?.mode ?? "auto");
  const [system, setSystem] = useState<"light" | "dark">("light");
  const toggleable = !config.theme?.mode || config.theme.mode === "auto";
  useEffect(() => {
    const q = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystem(q.matches ? "dark" : "light");
    on();
    q.addEventListener("change", on);
    if (toggleable)
      try {
        const saved = localStorage.getItem("forge-docs-theme");
        if (saved === "light" || saved === "dark") setMode(saved);
      } catch {
        // Follows the system.
      }
    return () => q.removeEventListener("change", on);
  }, [toggleable]);
  const resolved = mode === "auto" ? system : mode;
  const toggleTheme = () => {
    const next = resolved === "dark" ? "light" : "dark";
    setMode(next);
    try {
      localStorage.setItem("forge-docs-theme", next);
    } catch {
      // Not remembered.
    }
  };
  const theme = config.theme ?? {};
  const style = {
    ...(theme.accent && { "--fd-accent": theme.accent, "--fd-fill": theme.accent }),
    ...(theme.font && { "--fd-sans": theme.font }),
    ...(theme.monoFont && { "--fd-mono": theme.monoFont }),
    ...(theme.radius && { "--fd-r": theme.radius }),
  } as CSSProperties;

  // The request builder: Scalar's modal, a fixed overlay with its own list of operations. It is mounted into a plain element at the end of <body>,
  // outside this component, so that no ancestor's transform or filter can contain it. It tells the page when the visitor closes it.
  const [failed, setFailed] = useState<{ entry: OpEntry; error: string } | null>(null);
  const instance = useRef<ExplorerInstance | null>(null);
  const hostEl = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const live = useRef({ doc, creds, languages, preset, config });
  live.current = { doc, creds, languages, preset, config };
  const syncUrl = useCallback(
    (id: string | null) => {
      if (embed) return;
      try {
        history.replaceState(null, "", `${location.pathname}${searchWith(location.search, id !== null)}${id ? `#${id}` : location.hash}`);
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
      syncUrl(entry.id);
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
            syncUrl(null);
            opener.current?.focus({ preventScroll: true });
          };
        }
        instance.current.open({ path: entry.path, method: entry.method });
      } catch (e) {
        syncUrl(null);
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
  }, [resolved, theme.accent, theme.font, theme.monoFont, theme.radius]);

  // Where the address points: scroll to it, and open the builder when it asks.
  const started = useRef(false);
  useEffect(() => {
    if (!model || started.current) return;
    started.current = true;
    const hash = decodeURIComponent(location.hash.slice(1));
    const params = new URLSearchParams(location.search);
    const wanted = params.get("op");
    const byOp = !embed && wanted ? model.ops.find((o) => o.operationId === wanted) : undefined;
    const id = byOp?.id ?? hash;
    if (id) settleOn(rootRef.current, id);
    if (tryEnabled && !embed && (props.tryOpen || params.has("try"))) {
      const entry = byOp ?? model.ops.find((o) => o.id === hash) ?? model.ops[0];
      if (entry) void openBuilder(entry, null);
    }
  }, [model, embed, tryEnabled, props.tryOpen, openBuilder]);

  // Where the visitor is: the section nearest the top of the screen, for the navigation.
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const on = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      setActive(id || null);
      if (id) settleOn(rootRef.current, id);
    };
    setActive(decodeURIComponent(location.hash.slice(1)) || null);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !model || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
        let best: Element | null = null;
        for (const el of visible) if (!best || best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
        if (best?.id) setActive(best.id);
      },
      { rootMargin: "-12% 0px -80% 0px" },
    );
    root.querySelectorAll("[data-spy]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [model, guides.length]);

  useEffect(() => {
    if (!embed && doc) document.title = config.title ?? doc.info.title;
  }, [embed, doc, config.title]);

  // Search and the mobile menu.
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const nav = useMemo(() => (model ? buildNav(model, guides, hide, t) : []), [model, guides, hide.models, hide.webhooks, t]);
  const index = useMemo(() => (model ? buildIndex(model, guides, hide, t) : []), [model, guides, hide.models, hide.webhooks, t]);
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

  const context = useMemo<DocContext | null>(
    () =>
      doc && model
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
          }
        : null,
    [doc, model, config, t, origin, props.openapiUrl, languages, lang, props.slots, credentials, preset, tryEnabled, openBuilder, props.explorerUrl],
  );

  const Header = props.slots?.header;
  const SidebarFooter = props.slots?.["sidebar-footer"];
  const title = config.title ?? doc?.info.title ?? t("apiReference");
  const downloadUrl = props.openapiUrl && !hide.downloadLink ? `${props.openapiUrl}${all ? `${props.openapiUrl.includes("?") ? "&" : "?"}audience=all` : ""}` : undefined;
  const navigate = () => (setMenu(false), setQuery(""));

  // The development switch and the download link: in the header, and on a small screen in the navigation drawer.
  const tools = (
    <>
      {props.dev && (
        <label className="fd-switch" title={t("showAllHint")}>
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
      )}
      {downloadUrl && (
        <a className="fd-btn" href={downloadUrl} download="openapi.json">
          {t("openapiJson")}
        </a>
      )}
    </>
  );

  return (
    <div
      ref={rootRef}
      className={`fd ${embed ? "fd-embed" : "fd-page"}${props.className ? ` ${props.className}` : ""}`}
      data-theme={mode === "auto" ? undefined : mode}
      data-mode={resolved}
      style={style}
    >
      <a
        className="fd-skip"
        href="#fd-main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        {t("skipToContent")}
      </a>
      <header className="fd-top">
        <button type="button" className="fd-btn fd-menu" aria-expanded={menu} aria-controls="fd-side" onClick={() => setMenu(!menu)}>
          {t("menu")}
        </button>
        <a className="fd-brand" href={config.logo?.href ?? "#/introduction"}>
          {config.logo && <img src={config.logo.url} alt={config.logo.alt ?? ""} />}
          <span>{title}</span>
        </a>
        {doc && <span className="fd-version">{doc.info.version}</span>}
        {Header && (
          <div className="fd-slot fd-slot-header">
            <Suspense fallback={null}>
              <Header />
            </Suspense>
          </div>
        )}
        <div className="fd-top-actions">
          {model && model.schemes.length > 0 && (
            <button type="button" className="fd-btn" onClick={() => setAuthorizing(true)} data-set={Object.keys(creds).length ? "" : undefined}>
              {t("authorize")}
              {Object.keys(creds).length > 0 && <span className="fd-dot" role="img" aria-label={t("credentialsSet")} />}
            </button>
          )}
          {toggleable && (
            <button type="button" className="fd-btn" onClick={toggleTheme} title={t("toggleTheme")}>
              {resolved === "dark" ? t("light") : t("dark")}
            </button>
          )}
          <span className="fd-tools">{tools}</span>
        </div>
      </header>
      <div className="fd-layout">
        <div className="fd-side" id="fd-side" data-open={menu ? "" : undefined}>
          {!hide.search && (
            <div className="fd-search">
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={t("searchPlaceholder")}
                aria-label={t("search")}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && results[0]) {
                    location.hash = results[0].id;
                    navigate();
                  } else if (e.key === "Escape") setQuery("");
                }}
              />
            </div>
          )}
          <div className="fd-side-tools">{tools}</div>
          {query.trim() ? <SearchResults results={results} query={query.trim()} t={t} onNavigate={navigate} /> : <Nav groups={nav} active={active} t={t} onNavigate={navigate} />}
          {SidebarFooter && (
            <div className="fd-slot fd-slot-footer">
              <Suspense fallback={null}>
                <SidebarFooter />
              </Suspense>
            </div>
          )}
        </div>
        <button type="button" className="fd-scrim" tabIndex={-1} aria-hidden="true" data-open={menu ? "" : undefined} onClick={() => setMenu(false)} />
        <main className="fd-main" id="fd-main" ref={mainRef} tabIndex={-1}>
          {!doc ? (
            error ? (
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
            )
          ) : (
            context &&
            model && (
              <DocProvider value={context}>
                <Intro />
                {guideGroups(guides, t("guides")).flatMap((g) => g.guides).map((g) => (
                  <GuideView key={g.slug} guide={g} />
                ))}
                <Authentication />
                {model.groups.map((group, gi) => (
                  <div className="fd-group" key={gi}>
                    {group.tags.map((section) => (
                      <section className="fd-section" id={section.id} data-spy key={section.id} aria-labelledby={`${section.id}~h`}>
                        <TagHeader section={section} />
                        {section.ops.map((o) => (
                          <OperationView key={o.id} entry={o} />
                        ))}
                      </section>
                    ))}
                  </div>
                ))}
                {!hide.webhooks && <Webhooks events={model.webhooks} />}
                {!hide.models && <Models models={model.models} />}
              </DocProvider>
            )
          )}
        </main>
      </div>
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
