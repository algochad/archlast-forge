// Security headers, by Helmet, on the three kinds of response that are the app's or the engine's own pages:
//
//   - "api": the REST API a Nest app serves (`nest(http, ...)`): JSON that never renders, so nothing may load or frame it.
//   - "app": a full-stack app's pages (React + React Router): a policy that blocks injected inline scripts, eval, plugins and framing by
//     other sites, and lets everything a React app normally loads through (its own bundle, inline styles, images, fonts and APIs over https,
//     third-party SDKs from https). The engine's own inline script (the page's state) carries a per-request nonce, and so can the app's.
//   - "dashboard": the admin dashboard and its API: as strict as it can be. Nothing but its own files, no framing, no referrer.
//
// Each surface's options are built in three layers: the engine's preset, what the app's code says (`http.helmet()`, `nest(http, { helmet })`),
// and what the dashboard (or HELMET_CONFIG) says, which wins. Helmet itself turns the options into headers; they are worked out once per
// configuration and set on responses that don't already have them, so a handler's own header always wins.
import helmet, { type HelmetOptions } from "helmet";

export type Surface = "api" | "app" | "dashboard";
export const SURFACES: Surface[] = ["api", "app", "dashboard"];

/** Stands for the request's nonce in a policy; replaced on every response. */
export const NONCE = "'nonce-%FORGE_NONCE%'";
/** Where browsers send Content-Security-Policy violation reports; the dashboard shows them. */
export const CSP_REPORT_PATH = "/_csp";

/** What the app's code says, per surface: Helmet's own options, merged over the preset (CSP directives one by one), or false for none. */
export type HelmetConfig = Partial<Record<Surface, HelmetOptions | false>>;

/** What the dashboard (or HELMET_CONFIG) changes on a surface. Plain data, so it can be saved as a setting. */
export interface SurfaceOverride {
  /** false: no security headers on this surface at all. */
  enabled?: boolean;
  /** "report-only" sends the policy as Content-Security-Policy-Report-Only, to see what it would block before it does. */
  csp?: "enforce" | "report-only" | "off";
  /** Sources added to directives, as `{ "img-src": ["https://cdn.example.com"] }`. */
  add?: Record<string, string[]>;
  /** Directives replaced (`null` removes one). */
  directives?: Record<string, string[] | null>;
  hsts?: false | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  frameOptions?: "DENY" | "SAMEORIGIN" | false;
  referrerPolicy?: string | false;
  crossOriginResourcePolicy?: "same-origin" | "same-site" | "cross-origin" | false;
  crossOriginOpenerPolicy?: "same-origin" | "same-origin-allow-popups" | "unsafe-none" | false;
}
export type SecurityOverrides = Partial<Record<Surface, SurfaceOverride>>;

export interface SecurityContext {
  dev: boolean;
  /** The app is served over https (BETTER_AUTH_URL): HSTS and upgrade-insecure-requests only then. */
  https: boolean;
  /** Origins the browser loads files from and uploads them to (an S3 endpoint), beyond the app's own. */
  storageOrigins: string[];
  /** Collect CSP violation reports at CSP_REPORT_PATH. */
  reports: boolean;
}

type Directives = Record<string, string[]>;

/** The engine's starting point for each surface. */
export function presetFor(surface: Surface, ctx: SecurityContext): HelmetOptions {
  const hsts = ctx.https && !ctx.dev ? { maxAge: 31_536_000, includeSubDomains: false } : false;
  const report: Directives = ctx.reports ? { "report-uri": [CSP_REPORT_PATH] } : {};
  const upgrade: Directives = ctx.https && !ctx.dev ? { "upgrade-insecure-requests": [] } : {};
  const storage = ctx.storageOrigins;
  if (surface === "api")
    return {
      // A JSON answer never renders: nothing may load from it, frame it, or submit to it.
      contentSecurityPolicy: { useDefaults: false, directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"], "base-uri": ["'none'"], "form-action": ["'none'"] } },
      // CORS requests aren't affected; no-cors loads (an <img> of an API URL) only from the same site.
      crossOriginResourcePolicy: { policy: "same-site" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "no-referrer" },
      strictTransportSecurity: hsts,
      xFrameOptions: { action: "deny" },
    };
  if (surface === "app")
    return {
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          // No inline script without the page's nonce, no eval; the app's bundle and scripts over https (payment and analytics SDKs) load.
          "script-src": ["'self'", NONCE, "https:"],
          "script-src-attr": ["'none'"],
          // CSS-in-JS, style attributes and font stylesheets.
          "style-src": ["'self'", "'unsafe-inline'", "https:"],
          "img-src": ["'self'", "data:", "blob:", "https:", ...storage],
          "font-src": ["'self'", "data:", "https:"],
          "media-src": ["'self'", "data:", "blob:", "https:", ...storage],
          "connect-src": ["'self'", "https:", "wss:", ...(ctx.dev ? ["ws:"] : []), ...storage],
          "frame-src": ["'self'", "https:"],
          "worker-src": ["'self'", "blob:"],
          "manifest-src": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'", "https:"],
          "frame-ancestors": ["'self'"],
          ...upgrade,
          ...report,
        },
      },
      // Sign-in and payment popups keep their opener.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      strictTransportSecurity: hsts,
      xFrameOptions: { action: "sameorigin" },
    };
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:", ...storage],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'", ...storage],
        "worker-src": ["'self'", "blob:"],
        "manifest-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        ...upgrade,
        ...report,
      },
    },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: hsts,
    xFrameOptions: { action: "deny" },
  };
}

/** `scriptSrc` and `script-src` are the same directive to Helmet; the engine keeps the second spelling. */
const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function directivesOf(o: HelmetOptions): Directives | null {
  const csp = o.contentSecurityPolicy;
  if (csp === false || csp === undefined || csp === true) return csp === false ? null : {};
  return Object.fromEntries(Object.entries(csp.directives ?? {}).map(([k, v]) => [kebab(k), v === null ? [] : [...(v as Iterable<string>)].map(String)]));
}

/** Code's options over the preset: each top-level option replaced, CSP directives one by one (with `useDefaults` kept off). */
export function mergeHelmet(base: HelmetOptions, over: HelmetOptions | undefined): HelmetOptions {
  if (!over) return base;
  const out = { ...base, ...over } as HelmetOptions;
  const baseCsp = directivesOf(base);
  if (over.contentSecurityPolicy === false || baseCsp === null) return out;
  if (over.contentSecurityPolicy && typeof over.contentSecurityPolicy === "object") {
    const extra = over.contentSecurityPolicy.directives ?? {};
    const directives: Directives = { ...baseCsp };
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) delete directives[kebab(k)];
      else directives[kebab(k)] = [...(v as Iterable<string>)].map(String);
    }
    out.contentSecurityPolicy = { useDefaults: false, ...over.contentSecurityPolicy, directives };
  } else out.contentSecurityPolicy = base.contentSecurityPolicy;
  return out;
}

/** What the dashboard changes, as Helmet options over the ones before. */
export function applyOverride(o: HelmetOptions, v: SurfaceOverride | undefined): HelmetOptions | false {
  if (!v) return o;
  if (v.enabled === false) return false;
  const out: HelmetOptions = { ...o };
  let directives = directivesOf(o);
  if (v.csp === "off") directives = null;
  if (directives) {
    for (const [k, list] of Object.entries(v.directives ?? {})) {
      if (list === null) delete directives[kebab(k)];
      else directives[kebab(k)] = list;
    }
    for (const [k, list] of Object.entries(v.add ?? {})) directives[kebab(k)] = [...new Set([...(directives[kebab(k)] ?? []), ...list])];
    const reportOnly = v.csp === "report-only" || (v.csp === undefined && typeof o.contentSecurityPolicy === "object" && o.contentSecurityPolicy.reportOnly === true);
    out.contentSecurityPolicy = { useDefaults: false, directives, ...(reportOnly && { reportOnly: true }) };
  } else out.contentSecurityPolicy = false;
  if (v.hsts !== undefined) out.strictTransportSecurity = v.hsts === false ? false : { maxAge: v.hsts.maxAge ?? 31_536_000, includeSubDomains: v.hsts.includeSubDomains ?? false, preload: v.hsts.preload ?? false };
  if (v.frameOptions !== undefined) out.xFrameOptions = v.frameOptions === false ? false : { action: v.frameOptions === "DENY" ? "deny" : "sameorigin" };
  if (v.referrerPolicy !== undefined) out.referrerPolicy = v.referrerPolicy === false ? false : { policy: v.referrerPolicy as never };
  if (v.crossOriginResourcePolicy !== undefined) out.crossOriginResourcePolicy = v.crossOriginResourcePolicy === false ? false : { policy: v.crossOriginResourcePolicy };
  if (v.crossOriginOpenerPolicy !== undefined) out.crossOriginOpenerPolicy = v.crossOriginOpenerPolicy === false ? false : { policy: v.crossOriginOpenerPolicy };
  return out;
}

/**
 * The app's own inline script (the page's state) runs only with the page's nonce, so a policy for app pages that limits scripts always takes
 * it, whatever the code or the dashboard replaced `script-src` with.
 */
function withNonce(o: HelmetOptions): HelmetOptions {
  const directives = directivesOf(o);
  if (!directives) return o;
  const scripts = directives["script-src"] ?? directives["default-src"];
  if (!scripts || scripts.includes(NONCE)) return o;
  // A policy that allows any inline script on purpose: a nonce would switch that off (browsers ignore 'unsafe-inline' beside a nonce).
  const anyInline = scripts.includes("'unsafe-inline'") && !scripts.some((s) => s.startsWith("'nonce-") || s.startsWith("'sha"));
  if (anyInline) return o;
  const csp = o.contentSecurityPolicy as Exclude<HelmetOptions["contentSecurityPolicy"], boolean | undefined>;
  return { ...o, contentSecurityPolicy: { ...csp, directives: { ...directives, "script-src": [...scripts, NONCE] } } };
}

/** The headers Helmet sets for these options, in order: Helmet runs as it would in Express, against a response that only records them. */
export function headersOf(options: HelmetOptions): [string, string][] {
  const headers = new Map<string, string>();
  const res = { setHeader: (k: string, v: unknown) => void headers.set(k.toLowerCase(), String(v)), removeHeader: (k: string) => void headers.delete(k.toLowerCase()), getHeader: (k: string) => headers.get(k.toLowerCase()) };
  let failure: unknown;
  helmet(options)({ headers: {} } as never, res as never, (e?: unknown) => void (failure = e));
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  return [...headers];
}

/** Checks code's options can cross into the server (plain data: Helmet's function directives can't). */
export function checkHelmetConfig(where: string, c: unknown) {
  const visit = (v: unknown, at: string): void => {
    if (typeof v === "function") throw new Error(`${where}: ${at} is a function; Helmet options here must be plain data (the request's nonce is added for you)`);
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, `${at}.${k}`);
  };
  visit(c, "helmet");
}

/** Checks the dashboard's (or HELMET_CONFIG's) JSON, with the field that is wrong. */
export function parseOverrides(text: string | undefined): SecurityOverrides {
  if (!text?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("HELMET_CONFIG must be JSON, like {\"app\":{\"csp\":\"report-only\"}}");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HELMET_CONFIG must be an object of api, app and dashboard");
  for (const [surface, o] of Object.entries(value as Record<string, unknown>)) {
    if (!SURFACES.includes(surface as Surface)) throw new Error(`HELMET_CONFIG: "${surface}" isn't one of ${SURFACES.join(", ")}`);
    if (!o || typeof o !== "object") throw new Error(`HELMET_CONFIG.${surface} must be an object`);
    const s = o as SurfaceOverride;
    if (s.csp !== undefined && !["enforce", "report-only", "off"].includes(s.csp)) throw new Error(`HELMET_CONFIG.${surface}.csp must be enforce, report-only or off`);
    for (const key of ["add", "directives"] as const)
      for (const [d, list] of Object.entries(s[key] ?? {})) {
        if (!/^[a-z-]+$/.test(d)) throw new Error(`HELMET_CONFIG.${surface}.${key}: "${d}" isn't a CSP directive name`);
        if (list !== null && (!Array.isArray(list) || list.some((x) => typeof x !== "string" || /[;,\s]/.test(x))))
          throw new Error(`HELMET_CONFIG.${surface}.${key}.${d} must be a list of sources without spaces or semicolons`);
      }
    if (s.frameOptions !== undefined && ![false, "DENY", "SAMEORIGIN"].includes(s.frameOptions)) throw new Error(`HELMET_CONFIG.${surface}.frameOptions must be DENY, SAMEORIGIN or false`);
  }
  return value as SecurityOverrides;
}

export interface CspReport {
  at: number;
  surface: Surface | "unknown";
  directive: string;
  blocked: string;
  page: string;
  sample?: string;
  disposition: "enforce" | "report";
}

/** The engine's security headers: the options of each surface, their headers, and the CSP violations browsers reported. */
export class SecurityHeaders {
  private resolved = new Map<Surface, { options: HelmetOptions | false; headers: [string, string][] }>();
  private code: HelmetConfig = {};
  private overrides: SecurityOverrides = {};
  private enabled = true;
  readonly reports: CspReport[] = [];

  constructor(private ctx: SecurityContext) {
    this.build();
  }

  /** Recomputes the headers: after a load of the code (its `helmet` config), or a change on the dashboard. Throws, leaving things as they were, when Helmet refuses the options. */
  configure(o: { code?: HelmetConfig; overrides?: SecurityOverrides; enabled?: boolean }) {
    const before = { code: this.code, overrides: this.overrides, enabled: this.enabled };
    if (o.code !== undefined) this.code = o.code;
    if (o.overrides !== undefined) this.overrides = o.overrides;
    if (o.enabled !== undefined) this.enabled = o.enabled;
    try {
      this.build();
    } catch (e) {
      Object.assign(this, before);
      this.build();
      throw e;
    }
  }

  private build() {
    const next = new Map<Surface, { options: HelmetOptions | false; headers: [string, string][] }>();
    for (const surface of SURFACES) {
      const code = this.code[surface];
      let options: HelmetOptions | false = !this.enabled || code === false ? false : mergeHelmet(presetFor(surface, this.ctx), code);
      if (options) options = applyOverride(options, this.overrides[surface]);
      else if (this.enabled && this.overrides[surface]?.enabled === true) options = applyOverride(presetFor(surface, this.ctx), this.overrides[surface]);
      if (options && surface === "app") options = withNonce(options);
      next.set(surface, { options, headers: options ? headersOf(options) : [] });
    }
    this.resolved = next;
  }

  /** Whether this surface's policy wants a nonce on every response (the app's pages). */
  wantsNonce(surface: Surface) {
    return this.resolved.get(surface)!.headers.some(([, v]) => v.includes(NONCE));
  }

  /** Sets the surface's headers the response doesn't already have. A response whose headers can't change is copied first. */
  apply(surface: Surface, res: Response, nonce?: string): Response {
    const headers = this.resolved.get(surface)!.headers;
    if (!headers.length) return res;
    let out = res;
    for (const [name, value] of headers) {
      if (out.headers.has(name)) continue;
      const v = nonce ? value.replaceAll(NONCE, `'nonce-${nonce}'`) : value.replaceAll(` ${NONCE}`, "");
      try {
        out.headers.set(name, v);
      } catch {
        out = new Response(out.body, out); // Response.redirect() and fetched responses have immutable headers
        out.headers.set(name, v);
      }
    }
    return out;
  }

  /** A browser's violation report: `application/csp-report` or the Reporting API's `application/reports+json`. Kept in memory, the latest 200. */
  record(body: unknown, surfaceOf: (page: string) => Surface | "unknown") {
    const items = Array.isArray(body) ? body.map((r) => (r as { body?: unknown })?.body) : [(body as { "csp-report"?: unknown })?.["csp-report"]];
    for (const raw of items) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const page = String(r["document-uri"] ?? r.documentURL ?? "");
      const directive = String(r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"] ?? "");
      if (!directive) continue;
      let path = page;
      try {
        path = new URL(page).pathname;
      } catch {}
      this.reports.push({
        at: Date.now(),
        surface: surfaceOf(path),
        directive: directive.slice(0, 64),
        blocked: String(r["blocked-uri"] ?? r.blockedURL ?? "").slice(0, 300),
        page: path.slice(0, 300),
        ...((r["script-sample"] ?? r.sample) ? { sample: String(r["script-sample"] ?? r.sample).slice(0, 120) } : {}),
        disposition: (r.disposition ?? "enforce") === "report" ? "report" : "enforce",
      });
      if (this.reports.length > 200) this.reports.shift();
    }
  }

  /** Each surface as the dashboard shows it. */
  snapshot() {
    return {
      enabled: this.enabled,
      reportPath: this.ctx.reports ? CSP_REPORT_PATH : null,
      surfaces: SURFACES.map((surface) => {
        const r = this.resolved.get(surface)!;
        return {
          surface,
          on: r.options !== false,
          code: this.code[surface] === undefined ? "default" : this.code[surface] === false ? "off" : "customized",
          override: this.overrides[surface] ?? null,
          headers: r.headers.map(([name, value]) => ({ name, value: value.replaceAll(NONCE, "'nonce-…'") })),
        };
      }),
      reports: [...this.reports].reverse(),
    };
  }

  clearReports() {
    this.reports.length = 0;
  }
}
