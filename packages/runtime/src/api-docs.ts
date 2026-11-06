// What an app says about its API docs, in code: where they are served, who they are for, and what the OpenAPI document says beyond what the
// validators already do (the API's name and version, its servers, its real authentication, the shape of its errors, reusable parameters,
// response headers, and the webhooks it sends). `http.docs({...})` in forge/http.ts takes it; routes add their own part (RouteDocs) on
// `http.route()` and `@Contract()`. Browser-safe: types and plain checks only.
import type { Validator } from "./values";

/** An OpenAPI security scheme (https://spec.openapis.org/oas/v3.1.0#security-scheme-object). */
export type SecurityScheme =
  | { type: "http"; scheme: "bearer" | "basic" | (string & {}); bearerFormat?: string; description?: string }
  | { type: "apiKey"; name: string; in: "header" | "query" | "cookie"; description?: string }
  | {
      type: "oauth2";
      description?: string;
      flows: {
        clientCredentials?: { tokenUrl: string; refreshUrl?: string; scopes: Record<string, string> };
        authorizationCode?: { authorizationUrl: string; tokenUrl: string; refreshUrl?: string; scopes: Record<string, string> };
        password?: { tokenUrl: string; refreshUrl?: string; scopes: Record<string, string> };
        implicit?: { authorizationUrl: string; refreshUrl?: string; scopes: Record<string, string> };
      };
    }
  | { type: "openIdConnect"; openIdConnectUrl: string; description?: string };

/** One way to authenticate: scheme names (keys of `securitySchemes`) to the scopes they need. Several in a list are alternatives. */
export type SecurityRequirement = Record<string, string[]>;

/** A parameter several routes take: in `http.docs({ parameters })`, referred to by name from routes (or on every route with `global`). */
export interface DocParameter {
  in: "header" | "query" | "path" | "cookie";
  /** The parameter's name on the wire, such as `Idempotency-Key`. */
  name: string;
  schema?: Validator;
  description?: string;
  required?: boolean;
  example?: unknown;
  deprecated?: boolean;
  /** Every documented route takes it (a version header, say). Default false. */
  global?: boolean;
}

/** A header in a response. */
export interface DocHeader {
  description?: string;
  schema?: Validator;
}

/** An error a route can answer: its stable code and when it happens. A string is the code alone. */
export type DocError = string | { code: string; description?: string };

/** The documentation a route adds to its validators. Accepted by `http.route()` and `@Contract()`. */
export interface RouteDocs {
  /** Left out of the document and the docs page (still served, of course). Development's complete document lists it, marked internal. */
  hidden?: boolean;
  /** A stable operation id; default made from the method and path (or the Nest handler). */
  operationId?: string;
  deprecated?: boolean;
  /** How to call it: `[{ oauth: ["payments:write"] }]`; `[]` for a route that needs nothing. Default: the app's `security`. */
  security?: SecurityRequirement[];
  /** The statuses and stable codes it can answer besides its success, as `{ 404: "payment_not_found", 409: ["a", "b"] }`. */
  errors?: Record<number | string, DocError | DocError[]>;
  /** Reusable parameters it takes, by their key in `http.docs({ parameters })`. */
  parameters?: string[];
  /** Request headers it reads, by name. */
  headers?: Record<string, { description?: string; required?: boolean; schema?: Validator; example?: unknown }>;
  /** Headers its success response carries, by name. */
  responseHeaders?: Record<string, DocHeader>;
  /** The success status. Default 200 (201 for a Nest POST, as Nest answers). */
  status?: number;
  /** What the success response is, in a few words. */
  responseDescription?: string;
  /** The app's own snippets, shown before the generated ones: `[{ lang: "node", label: "Node SDK", source: "await midas.refunds.create(…)" }]`. */
  codeSamples?: { lang: string; label?: string; source: string }[];
}

/** One event the app sends to webhook endpoints. */
export interface WebhookEventDoc {
  summary?: string;
  description?: string;
  /** The event's `data`. */
  data?: Validator;
  /** A sample of `data`. */
  example?: unknown;
}

/** The page's look and behaviour. Mirrors DocsPageConfig in @archlast/forge-dashboard's api-docs/contract.ts, which the page reads. */
type DocsToken = "bg" | "surface" | "text" | "muted" | "faint" | "border" | "borderStrong" | "accent" | "accentFill" | "codeBg" | "inlineCodeBg" | "ok" | "warn" | "err" | "synKey" | "synStr" | "synNum" | "synLit";
type DocsLink = { label: string; href: string };

export interface ApiDocsPageConfig {
  title?: string;
  /** `url` on light, `dark` on dark; `title: false` shows the mark without the name. */
  logo?: { url: string; dark?: string; alt?: string; href?: string; title?: boolean };
  theme?: {
    preset?: "default" | "minimal" | "dark";
    mode?: "auto" | "light" | "dark";
    accent?: string;
    font?: string;
    monoFont?: string;
    radius?: string;
    /** The page's colours (`--fd-<name>`), one value or one per mode. */
    tokens?: Partial<Record<DocsToken, string | { light: string; dark: string }>>;
    code?: "auto" | "light" | "dark";
    pills?: "outline" | "tinted";
    sidebarWidth?: string;
    density?: "comfortable" | "compact";
  };
  layout?: {
    shell?: "sidebar" | "header";
    pages?: "operation" | "tag" | "single";
    referencePath?: string;
    toc?: boolean;
    pageActions?: false | ("copy" | "markdown")[];
    pagination?: boolean;
    breadcrumbs?: boolean;
  };
  nav?: {
    tabs?: ({ label: string; section: "guides" | "reference" } | DocsLink)[];
    footer?: DocsLink[];
    groups?: { collapsible?: boolean; case?: "sentence" | "upper" };
  };
  controls?: {
    authorize?: "header" | "sidebar" | "operation" | false;
    themeToggle?: false | "icon" | "text" | { style?: "icon" | "text"; place?: "header" | "sidebar" };
    devSwitch?: boolean;
    download?: "header" | "sidebar" | false;
  };
  content?: { responseHeaders?: "collapsed" | "open" };
  /** CSS for the page, or a file under forge/docs (`"theme.css"`), in a layer after the page's. */
  css?: string;
  codeSamples?: { languages?: ("curl" | "node" | "python" | "go" | "php" | "ruby" | "java" | "csharp")[] };
  explorer?:
    | false
    | {
        auth?: {
          preferredScheme?: string;
          oauth2?: { clientId?: string; scopes?: string[]; tokenUrl?: string; extraParams?: Record<string, string> };
        };
      };
  credentials?: "session" | "memory";
  hide?: { models?: boolean; webhooks?: boolean; search?: boolean; downloadLink?: boolean };
  strings?: Record<string, string>;
}

export interface ApiDocsConfig {
  /** Where the page is, such as "/docs" or "/developers/api". Default "/_api". API_DOCS_PATH, when set, wins. */
  path?: string;
  /** Where the OpenAPI document is. Default `<path>/openapi.json`; "/openapi.json" puts it at the root. */
  openapi?: string;
  /** The path that opens the page with the request builder showing, or false for no "Try it" at all. Default `<path>/explorer`. */
  explorer?: string | false;
  /** A prefix a reverse proxy adds in front of the server (the page is reached at `https://example.com/platform/docs`): "/platform". */
  basePath?: string;
  /** Serve the docs in production as well as in development. Default false. API_DOCS, when set, wins either way. */
  production?: boolean;
  /** Who the document is for: only paths under these prefixes (such as "/api/v1"). Default: everything documented. */
  include?: string[];
  /** Paths under these prefixes are left out (inbound webhooks, say). */
  exclude?: string[];
  /** List the reactive functions (`POST /rpc/<name>`). Default true; false for a REST API's public docs. */
  functions?: boolean;
  info?: {
    title?: string;
    /** The API's version as integrators know it ("v1"). Default: the release (a hash of the code). */
    version?: string;
    /** Markdown, shown at the top of the page. */
    description?: string;
    termsOfService?: string;
    contact?: { name?: string; url?: string; email?: string };
    license?: { name: string; url?: string; identifier?: string };
  };
  /** Where the API is. Default: the address the document was asked at. */
  servers?: (string | { url: string; description?: string })[];
  /** The app's authentication, such as an OAuth2 client-credentials scheme with its scopes. The engine's own (session cookie, Better Auth bearer) describe /rpc only. */
  securitySchemes?: Record<string, SecurityScheme>;
  /** The default for every route (each route's `security` wins): `[{ oauth: [] }]`. */
  security?: SecurityRequirement[];
  /** What the app's errors look like: their schema (named, so it is one schema in the document) and media type, such as RFC 9457's. */
  errors?: {
    schema: Validator;
    contentType?: string;
    /** Errors any route can answer, added to every documented route: `{ 401: "unauthorized", 429: "rate_limited" }`. */
    common?: Record<number | string, DocError | DocError[]>;
  };
  /** Reusable parameters, by key: routes refer to them in `parameters`, and `global` ones are on every route. */
  parameters?: Record<string, DocParameter>;
  /** Headers every response carries (a version header, a request id). */
  headers?: Record<string, DocHeader>;
  /** Descriptions (markdown) and order of the tags operations are grouped by. */
  tags?: { name: string; description?: string }[];
  /** Sections of the page's navigation, each a list of tags. */
  tagGroups?: { name: string; tags: string[] }[];
  /** The events the app sends to webhook endpoints (`WebhooksModule`), for the document's `webhooks` section. */
  webhooks?: {
    events: Record<string, WebhookEventDoc>;
    /** The retry schedule, as given to WebhooksModule.forRoot (its defaults otherwise). */
    retry?: { attempts?: number; delayMs?: number; factor?: number; maxDelayMs?: number };
    timeoutMs?: number;
    /** How old a signature receivers should accept. Default 5 minutes. */
    toleranceMs?: number;
  };
  page?: ApiDocsPageConfig;
}

/** The part of the configuration the server needs to route requests: plain data, carried in the manifest. */
export interface ApiDocsRouting {
  path: string;
  openapi: string;
  explorer: string | null;
  basePath: string;
  production: boolean;
  page: ApiDocsPageConfig;
}

const PATH = /^\/[A-Za-z0-9._~\/-]*$/;
const clean = (p: string) => p.replace(/\/+$/, "") || "/";

/** Checks a configuration where it is written (forge/http.ts loads), so a mistake fails at start with the field it is in. */
export function checkDocsConfig(c: ApiDocsConfig): void {
  const fail = (msg: string): never => {
    throw new Error(`http.docs(): ${msg}`);
  };
  for (const [key, value] of [["path", c.path], ["openapi", c.openapi], ["explorer", c.explorer || undefined], ["basePath", c.basePath]] as const)
    if (value !== undefined && (typeof value !== "string" || !PATH.test(value))) fail(`${key} must be a path like "/docs", got ${JSON.stringify(value)}`);
  if (c.path !== undefined && clean(c.path) === "/") fail(`path can't be "/": the docs need a path of their own, like "/docs"`);
  for (const key of ["include", "exclude"] as const) for (const p of c[key] ?? []) if (typeof p !== "string" || !p.startsWith("/")) fail(`${key} takes path prefixes like "/api/v1", got ${JSON.stringify(p)}`);
  const schemes = Object.keys(c.securitySchemes ?? {});
  const checkSecurity = (where: string, reqs: SecurityRequirement[] | undefined) => {
    for (const r of reqs ?? []) for (const name of Object.keys(r)) if (!schemes.includes(name)) fail(`${where} names the security scheme "${name}", which securitySchemes doesn't have`);
  };
  checkSecurity("security", c.security);
  for (const [key, p] of Object.entries(c.parameters ?? {})) if (!p?.name || !["header", "query", "path", "cookie"].includes(p.in)) fail(`parameters.${key} needs a name and an in of header, query, path or cookie`);
  for (const g of c.tagGroups ?? []) if (!g.name || !Array.isArray(g.tags)) fail(`each tagGroups entry needs a name and a list of tags`);
  if (c.errors && !c.errors.schema?.kind) fail(`errors.schema must be a validator, like v.object({ ... }, { name: "Problem" })`);
}

/** Checks what a route says about itself against the app's configuration: a scheme or a parameter it names must exist. */
export function checkRouteDocs(where: string, r: RouteDocs, c: ApiDocsConfig | undefined): void {
  const schemes = Object.keys(c?.securitySchemes ?? {});
  for (const req of r.security ?? []) for (const name of Object.keys(req)) if (!schemes.includes(name)) throw new Error(`${where}: security names "${name}", which http.docs({ securitySchemes }) doesn't have`);
  for (const p of r.parameters ?? []) if (!c?.parameters?.[p]) throw new Error(`${where}: parameters names "${p}", which http.docs({ parameters }) doesn't have`);
}

/** Where everything is, from the configuration (or the defaults), with API_DOCS_PATH winning for the page. */
export function docsRouting(c: ApiDocsConfig | undefined, envPath?: string): ApiDocsRouting {
  const path = clean(envPath || c?.path || "/_api");
  return {
    path,
    openapi: clean(c?.openapi ?? `${path}/openapi.json`),
    explorer: c?.explorer === false ? null : clean(c?.explorer ?? `${path}/explorer`),
    basePath: c?.basePath ? clean(c.basePath).replace(/^\/$/, "") : "",
    production: c?.production === true,
    page: { ...c?.page, ...(c?.explorer === false && { explorer: false as const }) },
  };
}
