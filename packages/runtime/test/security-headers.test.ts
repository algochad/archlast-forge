// Security headers (Helmet) on the REST API, the app's pages and the dashboard: presets, what code and the dashboard change, and where
// the server sets them.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyOverride, checkHelmetConfig, headersOf, mergeHelmet, NONCE, parseOverrides, presetFor, SecurityHeaders, type SecurityContext } from "../src/server/security-headers";
import { startServer, type AppHost, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const CTX: SecurityContext = { dev: false, https: false, storageOrigins: [], reports: true };
const as = (o: Parameters<typeof headersOf>[0]) => Object.fromEntries(headersOf(o));
const csp = (h: Record<string, string>) => h["content-security-policy"] ?? h["content-security-policy-report-only"];

describe("the presets", () => {
  test("the REST API: nothing loads from a JSON answer, nothing frames it", () => {
    const h = as(presetFor("api", CTX));
    expect(h["content-security-policy"]).toBe("default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'");
    expect(h).toMatchObject({ "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-site" });
    expect(h["strict-transport-security"]).toBeUndefined(); // http
  });

  test("app pages: inline scripts only with the nonce, no eval, no plugins; what React apps load still loads", () => {
    const h = as(presetFor("app", CTX));
    const policy = h["content-security-policy"]!;
    expect(policy).toContain(`script-src 'self' ${NONCE} https:`);
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline' https:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("report-uri /_csp");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin-allow-popups"); // sign-in and payment popups
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
  });

  test("the dashboard: only its own files", () => {
    const policy = as(presetFor("dashboard", { ...CTX, storageOrigins: ["https://s3.example.com"] }))["content-security-policy"]!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("connect-src 'self' https://s3.example.com"); // uploads go to the bucket
    expect(policy).toContain("frame-ancestors 'none'");
  });

  test("HSTS and upgrade-insecure-requests only in production over https; ws: in development for the reload socket", () => {
    const prod = as(presetFor("app", { ...CTX, https: true }));
    expect(prod["strict-transport-security"]).toBe("max-age=31536000");
    expect(prod["content-security-policy"]).toContain("upgrade-insecure-requests");
    const dev = as(presetFor("app", { ...CTX, https: true, dev: true }));
    expect(dev["strict-transport-security"]).toBeUndefined();
    expect(dev["content-security-policy"]).not.toContain("upgrade-insecure-requests");
    expect(dev["content-security-policy"]).toContain("connect-src 'self' https: wss: ws:");
  });
});

describe("what code and the dashboard change", () => {
  test("code's Helmet options merge over the preset, directive by directive, in either spelling", () => {
    const merged = mergeHelmet(presetFor("app", CTX), { contentSecurityPolicy: { directives: { imgSrc: ["'self'"], "frame-src": null as never, "connect-src": ["'self'", "https://api.example.com"] } }, xFrameOptions: { action: "deny" } });
    const h = as(merged);
    expect(h["content-security-policy"]).toContain("img-src 'self';");
    expect(h["content-security-policy"]).not.toContain("frame-src");
    expect(h["content-security-policy"]).toContain("connect-src 'self' https://api.example.com");
    expect(h["content-security-policy"]).toContain("object-src 'none'"); // the rest of the preset stays
    expect(h["x-frame-options"]).toBe("DENY");
    expect(as(mergeHelmet(presetFor("api", CTX), { contentSecurityPolicy: false }))["content-security-policy"]).toBeUndefined();
  });

  test("the dashboard's changes: sources added, report-only, HSTS, framing, off", () => {
    const o = applyOverride(presetFor("app", { ...CTX, https: true }), {
      add: { "script-src": ["https://js.stripe.com"], "frame-src": ["https://js.stripe.com"] },
      csp: "report-only",
      hsts: { maxAge: 600, includeSubDomains: true },
      frameOptions: "DENY",
    });
    const h = as(o as never);
    expect(h["content-security-policy"]).toBeUndefined();
    expect(h["content-security-policy-report-only"]).toContain(`script-src 'self' ${NONCE} https: https://js.stripe.com`);
    expect(h["strict-transport-security"]).toBe("max-age=600; includeSubDomains");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(applyOverride(presetFor("app", CTX), { enabled: false })).toBe(false);
    expect(as(applyOverride(presetFor("app", CTX), { csp: "off" }) as never)["content-security-policy"]).toBeUndefined();
  });

  test("the app's policy always keeps the nonce its own inline script needs, unless it allows any inline script on purpose", () => {
    const sh = new SecurityHeaders(CTX);
    sh.configure({ code: { app: { contentSecurityPolicy: { directives: { "script-src": ["'self'"] } } } } });
    expect(csp(Object.fromEntries(sh.snapshot().surfaces.find((s) => s.surface === "app")!.headers.map((x) => [x.name, x.value])))).toContain("script-src 'self' 'nonce-…'");
    sh.configure({ code: { app: { contentSecurityPolicy: { directives: { "script-src": ["'self'", "'unsafe-inline'"] } } } } });
    expect(sh.wantsNonce("app")).toBe(false); // a nonce would switch 'unsafe-inline' off
  });

  test("HELMET_CONFIG is checked, with the field that is wrong; code can't pass functions", () => {
    expect(parseOverrides('{"app":{"csp":"report-only","add":{"img-src":["https://cdn.example.com"]}}}')).toEqual({ app: { csp: "report-only", add: { "img-src": ["https://cdn.example.com"] } } });
    expect(() => parseOverrides("{nope")).toThrow(/JSON/);
    expect(() => parseOverrides('{"web":{}}')).toThrow(/"web" isn't one of api, app, dashboard/);
    expect(() => parseOverrides('{"app":{"csp":"maybe"}}')).toThrow(/csp/);
    expect(() => parseOverrides('{"app":{"add":{"img-src":["a; script-src *"]}}}')).toThrow(/without spaces or semicolons/);
    expect(() => checkHelmetConfig("forge/http.ts", { app: { contentSecurityPolicy: { directives: { "script-src": [() => "x"] } } } })).toThrow(/is a function/);
  });

  test("a change Helmet refuses leaves the headers as they were", () => {
    const sh = new SecurityHeaders(CTX);
    const before = JSON.stringify(sh.snapshot().surfaces);
    expect(() => sh.configure({ code: { app: { contentSecurityPolicy: { directives: { "script-src": ["'self';evil"] } } } } })).toThrow();
    expect(JSON.stringify(sh.snapshot().surfaces)).toBe(before);
  });
});

describe("setting them on responses", () => {
  test("a header the response has is kept; the nonce goes in; a fixed-header response is copied", () => {
    const sh = new SecurityHeaders(CTX);
    const res = sh.apply("app", new Response("x", { headers: { "x-frame-options": "DENY", "content-type": "text/html" } }), "abc");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-abc' https:");
    expect(sh.apply("app", new Response("x")).headers.get("content-security-policy")).toContain("script-src 'self' https:"); // no nonce: none named
    const redirect = sh.apply("api", Response.redirect("https://example.com", 302));
    expect(redirect.headers.get("x-content-type-options")).toBe("nosniff");
    expect(redirect.headers.get("location")).toBe("https://example.com/");
  });

  test("violation reports in both formats browsers send", () => {
    const sh = new SecurityHeaders(CTX);
    sh.record({ "csp-report": { "document-uri": "https://app.test/shop?x=1", "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js", disposition: "enforce" } }, () => "app");
    sh.record([{ type: "csp-violation", body: { documentURL: "https://app.test/_dashboard", effectiveDirective: "img-src", blockedURL: "https://i.example/a.png", disposition: "report", sample: "" } }], (p) => (p.startsWith("/_dashboard") ? "dashboard" : "app"));
    expect(sh.snapshot().reports).toMatchObject([
      { surface: "dashboard", directive: "img-src", disposition: "report", page: "/_dashboard" },
      { surface: "app", directive: "script-src-elem", blocked: "https://evil.example/x.js", page: "/shop", disposition: "enforce" },
    ]);
  });
});

describe("in the server", () => {
  const KEY = "helmet-admin-key";
  const started: RunningServer[] = [];
  afterAll(() => Promise.all(started.map((s) => s.stop({ graceful: false }))));
  const pages: AppHost = {
    fetch: (req, env) =>
      new URL(req.url).pathname === "/page"
        ? new Response(`<!doctype html><script nonce="${env.nonce}">1</script>`, { headers: { "content-type": "text/html" } })
        : undefined,
  };
  const serve = async (env: Record<string, string> = {}) => {
    const srv = await startServer({
      forgeDir: join(import.meta.dir, "fixture-helmet"),
      dev: true,
      app: pages,
      env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", ADMIN_KEY: KEY, LOG_FORMAT: "json", RATE_LIMIT_PER_MINUTE: "100000", ...env },
    });
    started.push(srv);
    return srv;
  };
  const admin = async (srv: RunningServer, op: string, input?: object) => {
    const res = input
      ? await fetch(`${srv.url}/_admin/${op}`, { method: "POST", body: JSON.stringify(input), headers: { "x-admin-key": KEY, "x-forge-admin": "1", "content-type": "application/json" } })
      : await fetch(`${srv.url}/_admin/${op}`, { headers: { "x-admin-key": KEY } });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body?.error?.message ?? body?.message);
    return body;
  };

  test("the REST API's answers get the API headers (with the code's options); other routes don't", async () => {
    const srv = await serve();
    const api = await fetch(`${srv.url}/api/ping`);
    expect(await api.json()).toEqual({ ok: true });
    expect(api.headers.get("content-security-policy")).toBe("default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'");
    expect(api.headers.get("referrer-policy")).toBe("same-origin"); // nest(http, { helmet })
    expect(api.headers.get("x-frame-options")).toBe("DENY");
    expect((await fetch(`${srv.url}/api/ping/framed`)).headers.get("x-frame-options")).toBe("SAMEORIGIN"); // the handler's own
    expect((await fetch(`${srv.url}/http/api/ping`)).headers.get("x-content-type-options")).toBe("nosniff"); // under /http too
    const plain = await fetch(`${srv.url}/plain`);
    expect(plain.headers.get("content-security-policy")).toBeNull(); // an http.route() answers as it likes
  });

  test("app pages get a fresh nonce the page and the policy share, and the code's options", async () => {
    const srv = await serve();
    const one = await fetch(`${srv.url}/page`);
    const nonce = /nonce="([^"]+)"/.exec(await one.text())![1]!;
    expect(one.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(one.headers.get("content-security-policy")).toContain("img-src 'self' https://images.example.com"); // http.helmet({ app })
    expect((await fetch(`${srv.url}/page`)).headers.get("content-security-policy")).not.toContain(nonce);
  });

  test("the dashboard's API is private and strict", async () => {
    const srv = await serve();
    const res = await fetch(`${srv.url}/_admin/settings`, { headers: { "x-admin-key": KEY } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("the dashboard changes them at once, saves them, and HELMET=off sends none", async () => {
    const srv = await serve();
    const info = await admin(srv, "security");
    expect(info.surfaces.map((s: any) => [s.surface, s.code])).toEqual([["api", "customized"], ["app", "customized"], ["dashboard", "default"]]);
    await admin(srv, "security.save", { overrides: { app: { csp: "report-only", add: { "script-src": ["https://js.stripe.com"] } }, api: { enabled: false } } });
    const page = await fetch(`${srv.url}/page`);
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(page.headers.get("content-security-policy-report-only")).toContain("https://js.stripe.com");
    expect((await fetch(`${srv.url}/api/ping`)).headers.get("content-security-policy")).toBeNull();
    const settings = await admin(srv, "settings");
    expect(settings.settings.find((s: any) => s.name === "HELMET_CONFIG")).toMatchObject({ source: "dashboard", pending: false });
    await expect(admin(srv, "security.save", { overrides: { app: { csp: "maybe" } } })).rejects.toThrow(/csp/);
    await admin(srv, "security.save", { enabled: false });
    expect((await fetch(`${srv.url}/page`)).headers.get("x-content-type-options")).toBeNull();
    await admin(srv, "security.save", { enabled: true, overrides: {} });
    expect((await fetch(`${srv.url}/api/ping`)).headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("the environment wins and locks; violation reports reach the dashboard", async () => {
    const srv = await serve({ HELMET_CONFIG: '{"dashboard":{"frameOptions":"SAMEORIGIN"}}' });
    const info = await admin(srv, "security");
    expect(info.locked).toEqual({ enabled: false, overrides: true });
    await expect(admin(srv, "security.save", { overrides: {} })).rejects.toThrow(/environment/);
    expect((await fetch(`${srv.url}/_admin/settings`, { headers: { "x-admin-key": KEY } })).headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const report = await fetch(`${srv.url}/_csp`, { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "document-uri": `${srv.url}/page`, "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js" } }) });
    expect(report.status).toBe(204);
    expect((await admin(srv, "security")).reports[0]).toMatchObject({ surface: "app", blocked: "https://evil.example/x.js" });
    await expect(serve({ HELMET_CONFIG: "{nope" })).rejects.toThrow(/JSON/);
  });
});
