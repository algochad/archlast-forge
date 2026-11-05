import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { Waf } from "../src/server/waf/engine";
import { Firewall } from "../src/server/waf/firewall";
import { WafPool } from "../src/server/waf/pool";
import { buildRules } from "../src/server/waf/rules";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const req = (url: string, headers: [string, string][] = [], method = "GET") => ({
  method,
  url,
  protocol: "HTTP/1.1",
  headers: [["host", "app.test"], ["user-agent", "Mozilla/5.0"], ...headers] as [string, string][],
  remoteAddr: "203.0.113.9",
  remotePort: 40000,
  serverPort: 3000,
});
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const json_ = (a: string) => JSON.stringify({ a });
const ATTACK = "1' OR '1'='1' --";

describe("the engine (Coraza's WASM on Bun)", () => {
  test("block mode stops injection, script and traversal attacks and lets ordinary requests by", async () => {
    const waf = await Waf.create({ rules: buildRules({ paranoia: 1 }), mode: "block" });
    expect(waf.inspect(req("/rpc/todos:list?args=%7B%22n%22%3A1%7D"))).toEqual({ action: "allow" });
    for (const url of [`/x?id=${encodeURIComponent(ATTACK)}`, "/x?q=%3Cscript%3Ealert(1)%3C/script%3E", "/x?file=../../../../etc/passwd"]) {
      const verdict = waf.inspect(req(url));
      expect(verdict.action).toBe("block");
      if (verdict.action === "block") expect([verdict.status, verdict.ruleId]).toEqual([403, 949110]);
    }
    waf.destroy();
  });

  test("it reads JSON bodies: an injection in a field is stopped, an apostrophe in a name is not", async () => {
    const waf = await Waf.create({ rules: buildRules({ paranoia: 1 }), mode: "block" });
    const post = req("/rpc/todos:add", [["content-type", "application/json"]], "POST");
    expect(waf.inspect(post, json({ text: "buy milk", note: "it's O'Brien's" })).action).toBe("allow");
    expect(waf.inspect(post, json({ text: `x' UNION SELECT password FROM users--` })).action).toBe("block");
    waf.destroy();
  });

  test("detect mode reports what would be stopped and stops nothing; clean requests are not reported", async () => {
    const waf = await Waf.create({ rules: buildRules({ paranoia: 1 }), mode: "detect" });
    expect(waf.inspect(req("/ok"))).toEqual({ action: "allow" });
    const verdict = waf.inspect(req(`/x?id=${encodeURIComponent(ATTACK)}`));
    expect(verdict.action).toBe("detected");
    if (verdict.action === "detected") expect(verdict.rules.map((r) => r.id)).toContain(942100);
    waf.destroy();
  });

  test("a disabled rule no longer counts", async () => {
    const url = "/x?q=%3Cscript%3Ealert(1)%3C/script%3E";
    const strict = await Waf.create({ rules: buildRules({ paranoia: 1 }), mode: "block" });
    const verdict = strict.inspect(req(url));
    expect(verdict.action).toBe("block");
    const ids = verdict.action === "block" ? verdict.rules.map((r) => r.id).filter((id) => id !== 949110) : [];
    expect(ids.length).toBeGreaterThan(0);
    const relaxed = await Waf.create({ rules: buildRules({ paranoia: 1, disabledRules: ids }), mode: "block" });
    expect(relaxed.inspect(req(url)).action).toBe("allow");
    strict.destroy();
    relaxed.destroy();
  });

  test("a bad paranoia level is refused", () => {
    expect(() => buildRules({ paranoia: 5 })).toThrow(/paranoia/);
  });
});

describe("the thread pool", () => {
  const stuck = new URL("./fixture-waf/stuck-worker.ts", import.meta.url);
  const workerUrl = new URL("../src/server/waf/worker.ts", import.meta.url);

  test("answers through a worker thread", async () => {
    const pool = await WafPool.start(workerUrl, { rules: buildRules({ paranoia: 1 }), mode: "block", size: 2 });
    const wire = (url: string) => ({ ...req(url), headers: req(url).headers });
    expect((await pool.inspect(wire("/ok"))).action).toBe("allow");
    expect((await pool.inspect(wire(`/x?id=${encodeURIComponent(ATTACK)}`))).action).toBe("block");
    // Concurrent requests spread over both threads and all come back.
    const verdicts = await Promise.all(Array.from({ length: 40 }, (_, i) => pool.inspect(wire(i % 2 ? "/ok" : `/x?id=${encodeURIComponent(ATTACK)}`))));
    expect(verdicts.map((v) => v.action)).toEqual(Array.from({ length: 40 }, (_, i) => (i % 2 ? "allow" : "block")));
    pool.close();
  });

  test("a thread that stops answering fails the request at the deadline and is replaced, not waited for", async () => {
    const pool = await WafPool.start(stuck, { rules: "", mode: "block", size: 1, deadlineMs: 150 });
    const started = performance.now();
    await expect(pool.inspect(req("/x"))).rejects.toThrow(/no answer|restarted/);
    expect(performance.now() - started).toBeLessThan(2000);
    // The replacement is there to be asked (and is stuck in the same way): the pool doesn't hang or stay broken.
    await expect(pool.inspect(req("/x"))).rejects.toThrow(/no answer|restarted/);
    pool.close();
  });

  test("rules that don't load stop the pool from starting, with the reason", async () => {
    await expect(WafPool.start(workerUrl, { rules: "SecRule NOT_A_VARIABLE", mode: "block", size: 1 })).rejects.toThrow();
  });
});

describe("configuration", () => {
  const base = { BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1" };
  test("the WAF is off unless WAF is set, whatever else is", () => {
    expect(loadConfig(base).waf).toBeUndefined();
    expect(loadConfig({ ...base, WAF_MODE: "detect" }).waf).toBeUndefined();
  });
  test("defaults: block mode, paranoia 1, one thread", () => {
    expect(loadConfig({ ...base, WAF: "1" }).waf).toEqual({ mode: "block", paranoia: 1, workers: 1, maxBodyBytes: 512 * 1024, ignorePaths: [], disabledRules: [] });
  });
  test("lists and bad values", () => {
    expect(loadConfig({ ...base, WAF: "on", WAF_IGNORE_PATHS: "/webhooks, /http/stripe", WAF_DISABLED_RULES: "942100, 941100" }).waf).toMatchObject({ ignorePaths: ["/webhooks", "/http/stripe"], disabledRules: [942100, 941100] });
    expect(() => loadConfig({ ...base, WAF: "1", WAF_MODE: "nope" })).toThrow(/WAF_MODE/);
    expect(() => loadConfig({ ...base, WAF: "1", WAF_PARANOIA: "5" })).toThrow(/WAF_PARANOIA/);
    expect(() => loadConfig({ ...base, WAF: "1", WAF_IGNORE_PATHS: "webhooks" })).toThrow(/WAF_IGNORE_PATHS/);
    expect(() => loadConfig({ ...base, WAF: "1", WAF_DISABLED_RULES: "abc" })).toThrow(/WAF_DISABLED_RULES/);
  });
});

describe("in the server", () => {
  const started: RunningServer[] = [];
  const serve = async (env: Record<string, string>) => {
    const srv = await startServer({
      forgeDir: join(import.meta.dir, "fixture"),
      env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json", METRICS_TOKEN: "m", WAF: "1", ...env },
    });
    started.push(srv);
    return srv;
  };
  afterAll(() => Promise.all(started.map((s) => s.stop({ graceful: false }))));

  const metric = async (srv: RunningServer, result: string) => {
    const text = await (await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer m" } })).text();
    return Number(new RegExp(`forge_waf_requests_total\\{result="${result}"\\} (\\d+)`).exec(text)?.[1]);
  };

  test("block mode: an attack gets a 403 in the engine's error shape; ordinary calls and their bodies go through untouched", async () => {
    const srv = await serve({});
    expect((await fetch(`${srv.url}/rpc/todos:events?args=%7B%7D`)).status).toBe(200);

    const attack = await fetch(`${srv.url}/rpc/todos:events?args=%7B%7D&q=${encodeURIComponent(ATTACK)}`);
    expect(attack.status).toBe(403);
    const body = (await attack.json()) as { error: { code: string; requestId: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.requestId).toBe(attack.headers.get("x-request-id")!);
    expect(JSON.stringify(body)).not.toMatch(/94\d{4}/); // the rule isn't handed to the attacker

    // The body is read for the WAF from a copy: the handler still gets every byte.
    const text = JSON.stringify({ note: "héllo wörld ✓ 日本語\nsecond line" });
    const echoed = await fetch(`${srv.url}/http/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: text });
    expect(await echoed.text()).toBe(text);
    const created = await fetch(`${srv.url}/rpc/todos:createList`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "O'Brien's list" }) });
    expect(created.status).toBe(200);
    // ... and an attack in a JSON body never reaches the function.
    const blocked = await fetch(`${srv.url}/rpc/todos:createList`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `x' UNION SELECT password FROM users--` }) });
    expect(blocked.status).toBe(403);

    expect(await metric(srv, "blocked")).toBe(2);
    expect((await fetch(`${srv.url}/health`)).status).toBe(200); // the engine's own routes aren't inspected
  });

  test("detect mode lets the attack through and counts it", async () => {
    const srv = await serve({ WAF_MODE: "detect" });
    const res = await fetch(`${srv.url}/rpc/todos:events?args=%7B%7D&q=${encodeURIComponent(ATTACK)}`);
    expect(res.status).toBe(200);
    expect(await metric(srv, "detected")).toBe(1);
    expect(await metric(srv, "blocked")).toBe(0);
  });

  test("WAF_IGNORE_PATHS leaves a prefix alone", async () => {
    const srv = await serve({ WAF_IGNORE_PATHS: "/http/echo" });
    const post = (body: string) => fetch(`${srv.url}/http/echo`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.status);
    expect(await post(json_(ATTACK))).toBe(200);
    expect(await fetch(`${srv.url}/http/hello?x=${encodeURIComponent(ATTACK)}`).then((r) => r.status)).toBe(403); // anything else is still inspected
  });

  test("a body over WAF_MAX_BODY_KB is not inspected, while its URL and headers still are", async () => {
    const srv = await serve({ WAF_MAX_BODY_KB: "1" });
    const post = (body: string, query = "") => fetch(`${srv.url}/http/echo${query}`, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.status);
    expect(await post(json_(ATTACK))).toBe(403);
    expect(await post(JSON.stringify({ a: ATTACK, pad: "x".repeat(4096) }))).toBe(200);
    expect(await post(JSON.stringify({ a: ATTACK, pad: "x".repeat(4096) }), `?x=${encodeURIComponent(ATTACK)}`)).toBe(403);
  });

  test("the WAF is not in the way when it is off", async () => {
    const srv = await serve({ WAF: "" });
    const res = await fetch(`${srv.url}/rpc/todos:events?args=%7B%7D&q=${encodeURIComponent(ATTACK)}`);
    expect(res.status).toBe(200);
    const text = await (await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer m" } })).text();
    expect(text).not.toContain("forge_waf");
  });
});

describe("a thread that can't load", () => {
  test("fails the start with the reason, instead of starting for ever", async () => {
    await expect(WafPool.start(new URL("./fixture-waf/does-not-exist.ts", import.meta.url), { rules: "", mode: "block", size: 1 })).rejects.toThrow();
  });
});

describe("the firewall, switched while the server runs", () => {
  const worker = new URL("../src/server/waf/worker.ts", import.meta.url);
  const config = (over: Record<string, unknown> = {}) => ({ mode: "block" as const, paranoia: 1, workers: 1, maxBodyBytes: 512 * 1024, ignorePaths: [], disabledRules: [], ...over });
  const request = (path: string, method = "GET", body?: string) => new Request(`http://app.test${path}`, { method, body, headers: { host: "app.test", "user-agent": "Mozilla/5.0", ...(body && { "content-type": "application/json" }) } });
  const check = (fw: Firewall, path: string, method = "GET", body?: string) => fw.check(request(path, method, body), new URL(`http://app.test${path}`), { address: "198.51.100.7", port: 1 }, 3000, 1 << 20, "req-1");
  const attack = `/x?id=${encodeURIComponent(ATTACK)}`;

  test("on, changed, off and on again: each change takes effect, and one that can't start leaves the firewall as it was", async () => {
    const fw = new Firewall(worker);
    try {
      expect(fw.enabled).toBe(false);
      expect((await check(fw, attack)).kind).toBe("pass"); // off: nothing is looked at
      await fw.apply(config({ mode: "detect" }));
      expect((await check(fw, attack)).kind).toBe("pass");
      expect(fw.stats.counters.detected).toBe(1);
      await fw.apply(config());
      expect((await check(fw, attack)).kind).toBe("block");
      await expect(fw.apply(config({ workers: 1, disabledRules: [0] }))).resolves.toBeUndefined(); // an id nothing has is only removed from nothing
      expect(fw.enabled).toBe(true);
      await fw.apply(undefined);
      expect(fw.enabled).toBe(false);
      expect((await check(fw, attack)).kind).toBe("pass");
      await fw.apply(config());
      expect((await check(fw, attack)).kind).toBe("block");
    } finally {
      fw.close();
    }
  });

  test("requests already on their way when the firewall is replaced are answered by it, not refused", async () => {
    const fw = new Firewall(worker);
    try {
      await fw.apply(config());
      const results: string[] = [];
      let stop = false;
      const traffic = (async () => {
        while (!stop) results.push((await check(fw, attack)).kind, (await check(fw, "/ok")).kind);
      })();
      for (const paranoia of [2, 1, 2]) await fw.apply(config({ paranoia }));
      stop = true;
      await traffic;
      expect(results.length).toBeGreaterThan(10);
      expect(results.filter((k) => k === "error")).toEqual([]); // never an error from a thread that was ended under a request
      expect(results.filter((k) => k === "block").length).toBe(results.filter((k) => k === "pass").length);
    } finally {
      fw.close();
    }
  });

  test("what it did is counted: events without the query string, rules, paths, clients and a timeline", async () => {
    const fw = new Firewall(worker);
    try {
      await fw.apply(config());
      await check(fw, "/ok?token=secret");
      for (let i = 0; i < 3; i++) await check(fw, attack);
      await check(fw, "/http/echo", "POST", JSON.stringify({ a: "x' UNION SELECT password FROM users--" }));
      const snap = fw.snapshot(5);
      expect(snap.counters).toMatchObject({ inspected: 5, blocked: 4, detected: 0, errors: 0 });
      expect(snap.timeline.length).toBe(5);
      expect(snap.timeline.at(-1)).toMatchObject({ inspected: 5, blocked: 4 });
      expect(snap.events.length).toBe(4);
      expect(snap.events[0]).toMatchObject({ action: "blocked", method: "POST", path: "/http/echo", ip: "198.51.100.7", requestId: "req-1" });
      expect(JSON.stringify(snap.events)).not.toContain("UNION"); // not the content of the request
      expect(snap.events[1]!.path).toBe("/x"); // the query string is left out
      expect(snap.events[1]!.rules.map((r) => r.id)).toContain(942100);
      expect(snap.events[1]!.score).toBeGreaterThanOrEqual(5);
      expect(snap.rules[0]).toMatchObject({ blocked: expect.any(Number), message: expect.any(String) });
      expect(snap.paths[0]).toMatchObject({ path: "/x", count: 3 });
      expect(snap.ips[0]).toMatchObject({ ip: "198.51.100.7", count: 4 });
      expect(snap.latency.p95).toBeGreaterThan(0);
      expect(snap.threads).toEqual([expect.objectContaining({ state: "up", restarts: 0 })]);
      expect(snap.threads[0]!.served).toBeGreaterThanOrEqual(5);
    } finally {
      fw.close();
    }
  });

  test("a described request is tried against the rules and isn't counted", async () => {
    const fw = new Firewall(worker);
    try {
      await expect(fw.test({ path: "/x" })).rejects.toThrow(/off/);
      await fw.apply(config({ ignorePaths: ["/webhooks"] }));
      const clean = await fw.test({ path: "/rpc/todos:list?args=%7B%7D" });
      expect(clean).toMatchObject({ action: "allowed", score: 0, threshold: 5, mode: "block", bodyInspected: false });
      const bad = await fw.test({ path: attack });
      expect(bad.action).toBe("blocked");
      expect(bad.score).toBeGreaterThanOrEqual(5);
      expect(bad.rules.map((r) => r.id)).toContain(942100);
      // Below the threshold: the matches are shown, and nothing stops it.
      const mild = await fw.test({ path: "/x", headers: { host: "127.0.0.1" } });
      expect(mild.action).toBe("allowed");
      expect(mild.score).toBeGreaterThan(0);
      expect(mild.score).toBeLessThan(5);
      expect(mild.rules.length).toBeGreaterThan(0);
      // Bodies are read, and a path the firewall leaves alone is said to be one.
      const body = await fw.test({ method: "POST", path: "/webhooks/stripe", headers: { "content-type": "application/json" }, body: json_(ATTACK) });
      expect(body).toMatchObject({ action: "blocked", bodyInspected: true, skipped: "/webhooks is in the ignored paths" });
      expect(fw.stats.counters.inspected).toBe(0);
      await expect(fw.test({ path: "no-slash" })).rejects.toThrow(/starts with/);
      await expect(fw.test({ method: "G ET" })).rejects.toThrow(/method/);
    } finally {
      fw.close();
    }
  });
});

describe("the dashboard's firewall operations", () => {
  const KEY = "waf-admin-key";
  const started: RunningServer[] = [];
  const serve = async (env: Record<string, string> = {}) => {
    const srv = await startServer({
      forgeDir: join(import.meta.dir, "fixture"),
      dev: true,
      env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json", METRICS_TOKEN: "m", ADMIN_KEY: KEY, ...env },
    });
    started.push(srv);
    return srv;
  };
  afterAll(() => Promise.all(started.map((s) => s.stop({ graceful: false }))));
  const admin = async (srv: RunningServer, op: string, input?: Record<string, unknown>, post = input !== undefined) => {
    const res = post
      ? await fetch(`${srv.url}/_admin/${op}`, { method: "POST", body: JSON.stringify(input), headers: { "x-admin-key": KEY, "x-forge-admin": "1", "content-type": "application/json" } })
      : await fetch(`${srv.url}/_admin/${op}`, { headers: { "x-admin-key": KEY } });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body?.error?.message ?? body?.message ?? `HTTP ${res.status}`);
    return body;
  };
  const hit = (srv: RunningServer) => fetch(`${srv.url}/rpc/todos:events?args=%7B%7D&q=${encodeURIComponent(ATTACK)}`).then((r) => r.status);

  test("an app that started without the firewall can switch it on, tune it and switch it off, with no restart", async () => {
    const srv = await serve();
    expect(await hit(srv)).toBe(200);
    const off = await admin(srv, "waf");
    expect(off).toMatchObject({ enabled: false, settings: null, draft: { mode: "block", paranoia: 1, workers: 1 }, locked: [] });

    await admin(srv, "waf.save", { enabled: true, mode: "detect" });
    expect(await admin(srv, "waf")).toMatchObject({ enabled: true, settings: { mode: "detect" } });
    expect(await hit(srv)).toBe(200);
    expect((await admin(srv, "waf")).counters.detected).toBe(1);

    const saved = await admin(srv, "waf.save", { mode: "block" });
    expect(saved.settings.mode).toBe("block");
    expect(await hit(srv)).toBe(403);
    const event = (await admin(srv, "waf")).events[0];
    expect(event.action).toBe("blocked");

    // The rule that stopped it can be switched off, and an ignored path isn't looked at.
    const rule = event.rules.find((r: any) => r.id !== 949110).id;
    await admin(srv, "waf.save", { disabledRules: [rule] });
    expect(await hit(srv)).toBe(200);
    await admin(srv, "waf.save", { disabledRules: [], ignorePaths: ["/rpc"] });
    expect(await hit(srv)).toBe(200);

    // It is saved like any setting, applied already (nothing pending), and shows in the log of changes.
    const settings = await admin(srv, "settings");
    const by = (name: string) => settings.settings.find((s: any) => s.name === name);
    expect(by("WAF")).toMatchObject({ value: "on", source: "dashboard", pending: false });
    expect(by("WAF_IGNORE_PATHS")).toMatchObject({ value: "/rpc", pending: false });
    expect(by("WAF_DISABLED_RULES").isSet).toBe(false);

    const tried = await admin(srv, "waf.test", { path: "/x?id=" + encodeURIComponent(ATTACK) });
    expect(tried.action).toBe("blocked"); // /x isn't under the ignored /rpc
    expect((await admin(srv, "waf.test", { path: "/rpc/todos:events?q=" + encodeURIComponent(ATTACK) })).skipped).toBe("/rpc is in the ignored paths");
    await admin(srv, "waf.save", { enabled: false });
    expect(await admin(srv, "waf")).toMatchObject({ enabled: false });
    expect(await hit(srv)).toBe(200);
    await expect(admin(srv, "waf.test", { path: "/x" })).rejects.toThrow(/off/);
  });

  test("values are checked, and a setting the environment gives can't be changed from the dashboard", async () => {
    const srv = await serve({ WAF: "1", WAF_MODE: "detect" });
    expect(await admin(srv, "waf")).toMatchObject({ enabled: true, settings: { mode: "detect" }, locked: expect.arrayContaining(["enabled", "mode"]) });
    await expect(admin(srv, "waf.save", { mode: "block" })).rejects.toThrow(/WAF_MODE is set in the environment/);
    await expect(admin(srv, "waf.save", { paranoia: 9 })).rejects.toThrow(/WAF_PARANOIA/);
    await expect(admin(srv, "waf.save", { ignorePaths: ["nope"] })).rejects.toThrow(/WAF_IGNORE_PATHS/);
    await expect(admin(srv, "waf.save", { disabledRules: ["abc"] })).rejects.toThrow(/WAF_DISABLED_RULES/);
    expect((await admin(srv, "waf")).settings.paranoia).toBe(1); // nothing was applied
    await admin(srv, "waf.save", { paranoia: 2 });
    expect((await admin(srv, "waf")).settings.paranoia).toBe(2);
  });

  test("a WAF setting saved from the Settings page applies at once too, and doesn't wait for a restart", async () => {
    const srv = await serve();
    const on = await admin(srv, "saveSetting", { name: "WAF", value: "on" });
    expect(on.applied).toMatch(/firewall/);
    expect(await hit(srv)).toBe(403);
    await admin(srv, "saveSetting", { name: "WAF_MODE", value: "detect" });
    expect(await hit(srv)).toBe(200);
    const settings = await admin(srv, "settings");
    expect(settings.settings.find((s: any) => s.name === "WAF_MODE")).toMatchObject({ value: "detect", pending: false });
    await admin(srv, "saveSetting", { name: "WAF", value: "off" });
    expect((await admin(srv, "waf")).enabled).toBe(false);
  });

  test("the metrics follow the firewall as it is switched", async () => {
    const srv = await serve();
    const metrics = async () => (await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer m" } })).text();
    expect(await metrics()).not.toContain("forge_waf");
    await admin(srv, "waf.save", { enabled: true });
    await hit(srv);
    const text = await metrics();
    expect(text).toMatch(/forge_waf_requests_total\{result="blocked"\} 1/);
    expect(text).toMatch(/forge_waf_rule_matches_total\{rule="94\d{4}"\} 1/);
  });
});
