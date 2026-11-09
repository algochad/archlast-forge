/**
 * HTML bundle routes (`import page from "./index.html"` used as a route) and the development server, native to the
 * engine: no second server and no proxying.
 *
 * An imported HTML file is an opaque `HTMLBundle`, but it names its source file (`.index`). `Bun.build`, the
 * bundler's library entry point, builds that file in this process; the outputs are held in memory and answered
 * from here like any other route.
 *
 * Development (`development: true`, or the default outside `NODE_ENV=production`): the source folders are
 * watched, a change rebuilds, and every open page is told to reload over the engine's own WebSocket. `console: true`
 * forwards the browser's console output to the server's. Errors from a failed rebuild are shown in the page, which
 * keeps its last good build.
 *
 * What an edit does to an open page:
 *  - a stylesheet-only change swaps the `<link>`s in place: no reload, the page keeps its state;
 *  - any other change reloads the page, which restores its scroll position, the values of its form fields and the focused one;
 *  - a failed build shows the error over the page and changes nothing else.
 * Module-level hot swap (React Fast Refresh) is not done: `Bun.build` bundles into one flat scope and its `reactFastRefresh` option
 * only adds the `$RefreshReg$`/`$RefreshSig$` calls, with no module registry to re-run a single module, which is what Bun's own dev
 * server has inside.
 */
import { type FSWatcher, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { Reply } from "./server.ts";

export type DevelopmentOption = boolean | { hmr?: boolean; console?: boolean };

/** `import x from "./page.html"`: a native `HTMLBundle`, or the `{ index, files }` manifest of a compiled executable. */
export function isHtmlBundle(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  if (Object.prototype.toString.call(v) === "[object HTMLBundle]") return true;
  return (
    "index" in v &&
    "files" in v &&
    Array.isArray((v as { files: unknown }).files)
  );
}

/** Where the dev client connects, and the topic its sockets share. */
export const DEV_SOCKET = "/_archlast/dev";
export const DEV_CLIENT = "/_archlast/dev.js";
export const DEV_TOPIC = "archlast:dev";
/** Marks the data of a dev-client socket. */
export const DEV = Symbol("archlast.dev-socket");

interface Entry {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
  etag: string;
}

interface Page {
  index: string;
  entry: Entry | null;
  error: string | null;
}

export interface BundleEvents {
  /** A rebuild finished (`ok`) or failed (`message`): tell the open pages. */
  publish(topic: string, data: string): void;
}

const encoder = new TextEncoder();

export class BundleHost {
  private pages = new Map<string, Page>(); // by route pattern
  private assets = new Map<string, Entry>(); // by URL path
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private building: Promise<void> | null = null;
  private queued = false;
  private stopped = false;
  readonly dev: boolean;
  readonly hmr: boolean;
  readonly console: boolean;
  /** The dev client (and its socket) is needed for live reload or for console forwarding. */
  readonly live: boolean;
  private devClient: Entry;

  constructor(
    development: DevelopmentOption | undefined,
    private events: BundleEvents,
  ) {
    this.dev =
      development === undefined
        ? process.env.NODE_ENV !== "production"
        : !!development;
    const o =
      typeof development === "object" && development !== null
        ? development
        : {};
    this.hmr = this.dev && o.hmr !== false;
    this.console = this.dev && o.console === true;
    this.live = this.hmr || this.console;
    this.devClient = entry(
      200,
      "text/javascript;charset=utf-8",
      encoder.encode(devClientSource(this.console)),
      "no-cache",
    );
  }

  get active(): boolean {
    return this.pages.size > 0;
  }

  /** Resolves when the first (or latest) build is done. Cheap to await when nothing is building. */
  get pending(): Promise<void> | null {
    return this.building;
  }

  /** (Re)defines the bundle routes by pattern and builds them. */
  setRoutes(routes: Record<string, unknown>): void {
    for (const w of this.watchers.splice(0)) w.close();
    this.pages.clear();
    this.assets.clear();
    for (const [pattern, bundle] of Object.entries(routes)) {
      const index = (bundle as { index?: string }).index;
      if (typeof index !== "string")
        throw new Error(
          `route ${pattern}: this HTML bundle does not name its source file`,
        );
      this.pages.set(pattern, {
        index: resolve(index),
        entry: null,
        error: null,
      });
    }
    if (this.pages.size > 0) this.start(); // building from this very call, so a request right after listen() waits for it
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers.splice(0)) w.close();
    this.pages.clear();
    this.assets.clear();
  }

  /** The answer for a bundle route. */
  page(pattern: string, req: Request): Response | Reply {
    const p = this.pages.get(pattern);
    if (!p) return new Reply("Not Found", { status: 404 });
    if (!p.entry)
      return new Reply(p.error ?? "The page is not built yet", { status: 500 });
    return respond(p.entry, req);
  }

  /** A bundled asset or the dev client script, when `pathname` is one. */
  asset(pathname: string, req: Request): Response | Reply | undefined {
    if (this.live && pathname === DEV_CLIENT)
      return respond(this.devClient, req);
    const e = this.assets.get(pathname);
    return e ? respond(e, req) : undefined;
  }

  isDevSocket(pathname: string): boolean {
    return this.live && pathname === DEV_SOCKET;
  }

  // ---------- building ----------

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.building)
        this.queued = true; // a change arrived during a build: build again when it ends
      else this.start();
    }, delay);
  }

  private start(): void {
    this.building = this.buildAll().finally(() => {
      this.building = null;
      if (this.queued && !this.stopped) {
        this.queued = false;
        this.schedule(0);
      }
    });
  }

  private async buildAll(): Promise<void> {
    const rebuilt =
      this.assets.size > 0 || [...this.pages.values()].some((p) => p.entry);
    const before = {
      assets: this.assets,
      html: new Map([...this.pages].map(([k, p]) => [k, p.entry] as const)),
    };
    const assets = new Map<string, Entry>();
    const watchDirs = new Set<string>();
    let failure: string | null = null;
    for (const [pattern, page] of this.pages) {
      try {
        const out = await this.buildOne(page.index, assets, watchDirs);
        page.entry = out;
        page.error = null;
      } catch (e) {
        failure = describe(e);
        page.error = failure;
        console.error(
          `[Tuyere] building ${page.index} failed:\n${failure}`,
        );
      }
    }
    if (this.stopped) return;
    if (failure === null) this.assets = assets;
    else for (const [k, v] of assets) this.assets.set(k, v); // keep serving the last good page; add what did build
    if (this.dev) {
      // A failed build lists no inputs: keep watching what was watched so the fix is noticed.
      if (failure !== null) for (const d of this.watched) watchDirs.add(d);
      this.watch(watchDirs);
    }
    if (rebuilt && this.hmr) {
      const message =
        failure === null
          ? changeOf(before, this.assets, this.pages)
          : { t: "error", message: failure };
      if (message) this.events.publish(DEV_TOPIC, JSON.stringify(message));
    }
  }

  private async buildOne(
    index: string,
    assets: Map<string, Entry>,
    watchDirs: Set<string>,
  ): Promise<Entry> {
    const result = (await Bun.build({
      entrypoints: [index],
      publicPath: "/",
      target: "browser",
      minify: !this.dev,
      sourcemap: this.dev ? "inline" : "none",
      define: {
        "process.env.NODE_ENV": JSON.stringify(
          this.dev ? "development" : "production",
        ),
      },
      metafile: true,
    } as Bun.BuildConfig & { metafile: boolean })) as Bun.BuildOutput & {
      metafile?: { inputs?: Record<string, unknown> };
    };
    if (!result.success)
      throw new AggregateError(
        result.logs,
        result.logs.map((l) => String(l)).join("\n"),
      );

    let html: Entry | null = null;
    const cache = this.dev ? "no-cache" : "public, max-age=31536000, immutable";
    for (const o of result.outputs) {
      const body = new Uint8Array(await o.arrayBuffer());
      const isHtml = o.type.startsWith("text/html");
      const e = entry(
        200,
        o.type,
        body,
        isHtml ? "no-cache" : cache,
        o.hash ?? undefined,
      );
      if (isHtml) html = this.live ? withDevClient(e) : e;
      else assets.set("/" + o.path.replace(/^\.\//, ""), e);
    }
    if (!html) throw new Error(`building ${index} produced no HTML`);
    for (const key of Object.keys(result.metafile?.inputs ?? {})) {
      if (key.includes("node_modules")) continue;
      watchDirs.add(
        dirname(
          resolve(key.startsWith("/") ? key : resolve(dirname(index), key)),
        ),
      );
    }
    watchDirs.add(dirname(index));
    return html;
  }

  private watched = new Set<string>();

  private watch(dirs: Set<string>): void {
    for (const w of this.watchers.splice(0)) w.close();
    this.watched = dirs;
    for (const dir of dirs) {
      try {
        this.watchers.push(
          watch(dir, { persistent: false }, (_event, name) => {
            if (name && /(^|\/)(\.|node_modules)/.test(name)) return;
            this.schedule(40);
          }),
        );
      } catch {
        // a folder that vanished or cannot be watched: the next successful build lists the current ones
      }
    }
  }
}

const STYLESHEET_HREFS = /<link\b[^>]*>/gi;

/** The stylesheet URLs a page's HTML links, in order. */
export function stylesheetsOf(html: string): string[] {
  const hrefs: string[] = [];
  for (const tag of html.match(STYLESHEET_HREFS) ?? []) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const url = href?.[1] ?? href?.[2] ?? href?.[3];
    if (url) hrefs.push(url);
  }
  return hrefs;
}

const isCss = (path: string) => path.endsWith(".css");

/**
 * What a finished rebuild means for open pages: nothing (`null`), swap stylesheets (`css`: old URL to new URL), or reload. Only a
 * change confined to stylesheets can be swapped: every script is the same file with the same bytes, and each page's HTML is the same
 * apart from the stylesheet URLs (their names carry a hash, so a changed stylesheet changes its page's HTML too).
 */
export function changeOf(
  before: { assets: Map<string, Entry>; html: Map<string, Entry | null> },
  assets: Map<string, Entry>,
  pages: Map<string, Page>,
): { t: "reload" } | { t: "css"; swap: Record<string, string> } | null {
  const dec = new TextDecoder();
  const scripts = (m: Map<string, Entry>) =>
    [...m]
      .filter(([k]) => !isCss(k))
      .map(([k, v]) => `${k}=${v.etag}`)
      .sort()
      .join("\n");
  const swap: Record<string, string> = {};
  let htmlSame = true;
  let anyChange = scripts(before.assets) !== scripts(assets);
  if (anyChange) return { t: "reload" };
  for (const [pattern, page] of pages) {
    const old = before.html.get(pattern);
    if (!old || !page.entry) return { t: "reload" };
    if (old === page.entry) continue;
    const [a, b] = [dec.decode(old.body), dec.decode(page.entry.body)];
    const [la, lb] = [stylesheetsOf(a), stylesheetsOf(b)];
    if (la.length !== lb.length) return { t: "reload" };
    // The same HTML once the stylesheet URLs are taken out?
    let [ta, tb] = [a, b];
    la.forEach((u, i) => {
      ta = ta.replace(u, "\0");
      tb = tb.replace(lb[i]!, "\0");
      if (u !== lb[i]) swap[u] = lb[i]!;
    });
    if (ta !== tb) htmlSame = false;
  }
  if (!htmlSame) return { t: "reload" };
  // A stylesheet that changed under the same name (no hash) is swapped by the page re-requesting it.
  for (const [k, v] of assets)
    if (
      isCss(k) &&
      before.assets.get(k)?.etag !== v.etag &&
      !Object.values(swap).includes(k)
    )
      swap[k] = k;
  anyChange = Object.keys(swap).length > 0;
  return anyChange ? { t: "css", swap } : null;
}

/** Build errors as readable text: message, then file:line:column and the offending line when the bundler gave them. */
function describe(e: unknown): string {
  const list =
    e instanceof AggregateError && e.errors.length > 0 ? e.errors : [e];
  return list
    .map((x) => {
      const m = x as {
        message?: string;
        position?: {
          file?: string;
          line?: number;
          column?: number;
          lineText?: string;
        } | null;
      };
      const p = m.position;
      const where = p?.file
        ? `${p.file}:${p.line ?? "?"}:${p.column ?? "?"}`
        : "";
      return [
        m.message ?? String(x),
        where && `  at ${where}`,
        p?.lineText && `  ${p.lineText.trim()}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** A cacheable answer: etag from the build hash (or the bytes), content-type and cache policy as given. */
function entry(
  status: number,
  type: string,
  body: Uint8Array,
  cache: string,
  hash?: string,
): Entry {
  const etag = `"${hash ?? Bun.hash(body).toString(16)}"`;
  return {
    status,
    headers: [
      ["content-type", type],
      ["cache-control", cache],
      ["etag", etag],
    ],
    body,
    etag,
  };
}

function withDevClient(e: Entry): Entry {
  const html = new TextDecoder().decode(e.body);
  const tag = `<script src="${DEV_CLIENT}"></script>`;
  const patched = html.includes("</head>")
    ? html.replace("</head>", `${tag}</head>`)
    : html + tag;
  const cache = e.headers.find(([k]) => k === "cache-control")![1];
  return entry(200, "text/html;charset=utf-8", encoder.encode(patched), cache);
}

function respond(e: Entry, req: Request): Response | Reply {
  const inm = req.headers.get("if-none-match");
  if (
    inm &&
    inm.split(",").some((t) => t.trim().replace(/^W\//, "") === e.etag)
  )
    return new Reply(null, { status: 304, headers: [["etag", e.etag]] });
  return new Reply(e.body, { status: e.status, headers: e.headers });
}

/** The script injected into pages in development: reloads on rebuild, shows build errors, forwards the console. */
function devClientSource(forwardConsole: boolean): string {
  return `(() => {
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + ${JSON.stringify(DEV_SOCKET)};
  let ws, overlay;
  const queue = [];
  const send = (m) => { const s = JSON.stringify(m); if (ws && ws.readyState === 1) ws.send(s); else if (queue.length < 200) queue.push(s); };
  const show = (message) => {
    if (!overlay) {
      overlay = document.createElement("pre");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;overflow:auto;background:rgba(20,0,0,.92);color:#ffb4b4;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap";
      document.body.appendChild(overlay);
    }
    overlay.textContent = message;
  };
  const KEY = "archlast:state:" + location.pathname + location.search;
  const fields = () => [...document.querySelectorAll("input,textarea,select")];
  const saveState = () => {
    try {
      const f = fields();
      sessionStorage.setItem(KEY, JSON.stringify({
        x: scrollX, y: scrollY, active: f.indexOf(document.activeElement),
        fields: f.map((e) => [e.tagName, e.type, e.type === "checkbox" || e.type === "radio" ? e.checked : e.value]),
      }));
    } catch {}
  };
  const restoreState = () => {
    let s; try { s = JSON.parse(sessionStorage.getItem(KEY) || "null"); sessionStorage.removeItem(KEY); } catch {}
    if (!s) return;
    const f = fields();
    if (f.length === s.fields.length) f.forEach((e, i) => {
      const [tag, type, v] = s.fields[i];
      if (e.tagName !== tag || e.type !== type) return;
      if (type === "checkbox" || type === "radio") e.checked = v; else if (type !== "file" && type !== "password") e.value = v;
    });
    if (s.active >= 0 && f[s.active]) f[s.active].focus();
    scrollTo(s.x, s.y);
  };
  // After the page has run its scripts: a framework renders the fields after DOMContentLoaded.
  const afterLoad = () => requestAnimationFrame(() => requestAnimationFrame(restoreState));
  if (document.readyState === "complete") afterLoad(); else addEventListener("load", afterLoad);
  const swapCss = (swap) => {
    for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
      const old = link.getAttribute("href");
      const to = swap[old] ?? swap[new URL(link.href).pathname];
      if (!to) continue;
      const next = link.cloneNode();
      next.href = to + (to === old ? (to.includes("?") ? "&" : "?") + "t=" + Date.now() : "");
      next.onload = () => link.remove();
      next.onerror = () => next.remove();
      link.after(next);
    }
  };
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { for (const q of queue.splice(0)) ws.send(q); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "reload") { saveState(); location.reload(); }
      else if (m.t === "css") swapCss(m.swap);
      else if (m.t === "error") show("Build failed\\n\\n" + m.message);
    };
    ws.onclose = () => setTimeout(connect, 500);
  };
  connect();
  ${
    forwardConsole
      ? `const fmt = (v) => { if (typeof v === "string") return v; if (v instanceof Error) return v.stack || String(v); try { return JSON.stringify(v); } catch { return String(v); } };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); send({ t: "console", level, text: args.map(fmt).join(" ") }); };
  }
  addEventListener("error", (e) => send({ t: "console", level: "error", text: e.message + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : "") }));
  addEventListener("unhandledrejection", (e) => send({ t: "console", level: "error", text: "Unhandled rejection: " + fmt(e.reason) }));`
      : ""
  }
})();
`;
}

/** Prints a forwarded browser console message the way Bun's dev server does. */
export function printBrowserConsole(raw: string | Uint8Array): void {
  try {
    const m = JSON.parse(
      typeof raw === "string" ? raw : new TextDecoder().decode(raw),
    ) as { t?: string; level?: string; text?: string };
    if (m.t !== "console" || typeof m.text !== "string") return;
    const out =
      m.level === "error" || m.level === "warn" ? console.error : console.log;
    out(`[browser] ${m.text}`);
  } catch {
    // not ours
  }
}
