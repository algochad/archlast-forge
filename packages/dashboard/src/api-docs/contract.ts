// The interfaces between the three parts of the API docs: the engine (which builds the OpenAPI document and decides which paths are the
// docs'), the docs page (host.ts and app.tsx in this folder, plus the embeddable React component), and the request builder ("Try it"), which
// is built from the engine's fork of Scalar (packages/dashboard/scalar) and loaded only when someone opens it.
//
// Nothing here runs: it is types only, imported by each side so they agree.

// ---------------------------------------------------------------------------------------------------------------------------------
// The page's configuration. It comes from the app's code (`http.docs({ page: ... })` in forge/http.ts), through the engine, to the host,
// which writes it into the page's HTML as JSON (<script type="application/json" id="forge-docs-config">). It is not part of the OpenAPI
// document, which stays standard.

export type CodeSampleLanguage = "curl" | "node" | "python" | "go" | "php" | "ruby" | "java" | "csharp";

export interface DocsTheme {
  /** "auto" follows the visitor's system setting, with a toggle on the page. Default "auto". */
  mode?: "auto" | "light" | "dark";
  /** The accent colour (links, buttons, the active item), any CSS colour. */
  accent?: string;
  /** Font stacks for text and code. Default: the engine's (Geist, Geist Mono). */
  font?: string;
  monoFont?: string;
  /** Corner radius, a CSS length. */
  radius?: string;
}

/** What the request builder starts with, for the app's real authentication. Credentials themselves are never configured: the visitor enters them. */
export interface AuthPreset {
  /** The security scheme (a key of `components.securitySchemes`) selected first. */
  preferredScheme?: string;
  oauth2?: {
    /** Pre-filled client id (not a secret). */
    clientId?: string;
    /** Scopes selected by default. */
    scopes?: string[];
    /** Overrides the token URL of the scheme's flow: absolute, or a path resolved against the API server's origin. */
    tokenUrl?: string;
    /** Extra form fields sent to the token endpoint, such as `{ resource: "https://api.example.com/api/v1" }` (RFC 8707) or `audience`. */
    extraParams?: Record<string, string>;
  };
}

export interface DocsPageConfig {
  /** The name in the header. Default: the document's `info.title`. */
  title?: string;
  logo?: { url: string; alt?: string; href?: string };
  theme?: DocsTheme;
  /** Generated code samples, in this order. Default ["curl", "node", "python"]. Operations' own `x-codeSamples` always come first. */
  codeSamples?: { languages?: CodeSampleLanguage[] };
  /** The request builder. `false` turns "Try it" off (the page still documents everything). */
  explorer?: false | { auth?: AuthPreset };
  /** Where credentials the visitor enters are kept: "session" (sessionStorage, the default) or "memory" (gone on reload). */
  credentials?: "session" | "memory";
  /** Sections the page can leave out. */
  hide?: { models?: boolean; webhooks?: boolean; search?: boolean; downloadLink?: boolean };
  /**
   * Text the page shows, by key, for another language: STRING_KEYS in strings.ts lists the keys and their English text. Keys that start
   * with "apiClient." go to the request builder instead (Scalar's own keys, such as "apiClient.requestBlock.authentication").
   */
  strings?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The host: what the engine's server calls (`startServer({ apiDocs })`, the CLI passes `@archlast/forge-dashboard/api-docs`).

export interface DocsServeOptions {
  /** The page's path, e.g. "/docs" or "/_api". No trailing slash, never "/". */
  base: string;
  /** The same path as the browser sees it (a reverse proxy's sub-path in front, `basePath`): what URLs in the HTML start with. */
  publicBase: string;
  /** The OpenAPI document's URL as the browser sees it, e.g. "/platform/docs/openapi.json". The engine serves it, not the host. */
  openapiUrl: string;
  /** The path (as the server sees it) that opens the page with the request builder showing, e.g. "/docs/explorer"; null when it is off. */
  explorerPath: string | null;
  /** In development the page may ask for the complete document (`openapi.json?audience=all`), which also lists what the public one leaves out. */
  dev: boolean;
  forgeDir: string;
  page: DocsPageConfig;
}

/**
 * The host answers exactly these paths and nothing else below `base`, so the app's own pages under the same prefix keep working:
 *   - `base` and `base + "/"`: the page
 *   - `base + "/_docs/*"`: its assets, fonts and the request builder's bundle
 *   - `explorerPath`: the page with the builder open
 * It returns null for anything else (and for an unknown asset), and the engine then hands the request to the app.
 */
export interface DocsHost {
  serve(req: Request, options: DocsServeOptions): Promise<Response | null>;
  /** The paths the host would answer for these options, as exact paths and prefixes: the engine checks them against the app's routes at start. */
  paths(options: Pick<DocsServeOptions, "base" | "explorerPath">): { exact: string[]; prefixes: string[] };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The request builder: `<publicBase>/_docs/explorer.js` (and its CSS, which the script loads itself) defines `window.ForgeExplorer`.
// The page loads it the first time someone presses "Try it" (and prefetches it on hover or focus of the button).

export interface ExplorerCredentials {
  /** By security scheme name (a key of `components.securitySchemes`). */
  [scheme: string]:
    | { type: "http"; token?: string; username?: string; password?: string }
    | { type: "apiKey"; value: string }
    | { type: "oauth2"; clientId?: string; clientSecret?: string; scopes?: string[]; accessToken?: string; expiresAt?: number };
}

export interface ExplorerOptions {
  /** The OpenAPI 3.1 document, already fetched by the page. */
  document: object;
  /** Where requests go when the document has no `servers`: the page's origin. */
  baseServerUrl: string;
  /** The page's resolved colours and fonts, so the builder matches it; `mode` follows the page's toggle (call update() when it changes). */
  theme: { mode: "light" | "dark"; accent: string; background: string; surface: string; text: string; muted: string; border: string; font: string; monoFont: string; radius: string };
  auth?: AuthPreset;
  /** What the visitor has entered on the page; the builder starts with it. */
  credentials?: ExplorerCredentials;
  /** Called when the visitor enters or fetches credentials in the builder, so the page keeps one store for both. */
  onCredentials?: (credentials: ExplorerCredentials) => void;
  codeSamples?: CodeSampleLanguage[];
  strings?: Record<string, string>;
}

export interface ExplorerInstance {
  /** Opens the builder on one operation, filled from its schema and examples. */
  open(target: { path: string; method: string }): void;
  close(): void;
  update(options: Partial<ExplorerOptions>): void;
  destroy(): void;
  /** Called when the visitor closes the builder (its close button or Escape), not when the page calls close() or destroy(). */
  onClose?: () => void;
}

export interface ForgeExplorerGlobal {
  /** The fork's version: the upstream release it is pinned to and the patch series, e.g. "scalar release-2026-10-30-66ba1d7 + 4 patches". */
  version: string;
  mount(el: HTMLElement, options: ExplorerOptions): ExplorerInstance;
}

declare global {
  interface Window {
    ForgeExplorer?: ForgeExplorerGlobal;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// OpenAPI extensions the engine writes and the page reads (everything else in the document is standard OpenAPI 3.1).
//
// - `x-tagGroups: { name: string; tags: string[] }[]` at the top level: the left navigation's sections, in order (Redoc's convention).
// - `x-codeSamples: { lang: string; label?: string; source: string }[]` on an operation: the app's own snippets (Redoc's and Scalar's convention).
// - `x-error-codes: { status: string; code: string; description?: string }[]` on an operation: the stable error codes it can answer.
// - `x-scopes: string[]` on an operation: the scopes its security needs, flattened for display (they are also in `security`).
// - `x-internal: true` on an operation: only in the complete document of development (`?audience=all`); the page marks it.
// - `x-webhooks-signing` at the top level, when the document has `webhooks`:
export interface WebhooksSigning {
  /** "standard": Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">). */
  scheme: "standard";
  /** The envelope every event is sent in: `{ type, timestamp, data }`. */
  envelope: { type: string; timestamp: string; data: string };
  /** Attempts in all, the first retry's delay, the factor, the longest wait, and the per-attempt timeout, in ms. */
  retry: { attempts: number; delayMs: number; factor: number; maxDelayMs: number; timeoutMs: number };
  /** How old a signed timestamp a receiver should accept. */
  toleranceMs: number;
}
