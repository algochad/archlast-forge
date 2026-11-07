import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompatServer, serveCompat } from "../src/compat.ts";
import type { BackendName } from "../src/index.ts";
import page from "./fixtures/site/index.html";
import other from "./fixtures/site/other.html";

const servers: CompatServer<any>[] = [];
afterAll(() => servers.forEach((s) => void s.stop(true)));
const start = (o: Parameters<typeof serveCompat>[0]) => {
    const s = serveCompat({ port: 0, ...o });
    servers.push(s);
    return s;
};
const get = (s: CompatServer<any>, path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${path}`, init);
const assetsOf = (html: string) => [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`HTML bundles: ${backend}`, () => {
        test("a bundle route serves the page and its bundled assets; other routes and fetch still work", async () => {
            const s = start({
                backend,
                development: false,
                routes: {
                    "/": page,
                    "/other": other,
                    "/api/ping": () => new Response("pong"),
                },
                fetch: (req) => new Response(`fallback ${new URL(req.url).pathname}`, { status: 404 }),
            });
            const r = await get(s, "/");
            expect(r.status).toBe(200);
            expect(r.headers.get("content-type")).toContain("text/html");
            const html = await r.text();
            const assets = assetsOf(html);
            expect(assets.length).toBe(2);
            const bodies: Record<string, string> = {};
            for (const a of assets) {
                const res = await get(s, a);
                expect(res.status).toBe(200);
                bodies[a] = await res.text();
            }
            const js = assets.find((a) => a.endsWith(".js"))!, css = assets.find((a) => a.endsWith(".css"))!;
            expect(bodies[js]).toContain("SITE_MARKER_ONE");
            expect(bodies[css]).toContain("#123456");
            expect((await get(s, js)).headers.get("content-type")).toContain("javascript");
            expect(await (await get(s, "/api/ping")).text()).toBe("pong");
            const nf = await get(s, "/nothing/here");
            expect([nf.status, await nf.text()]).toEqual([404, "fallback /nothing/here"]);
            expect(await (await get(s, "/other")).text()).toContain("<script");
            expect(s.pendingRequests).toBe(0);
        });

        test("hashed assets are cached in memory and revalidate with 304", async () => {
            const s = start({ backend, development: false, routes: { "/": page } });
            const js = assetsOf(await (await get(s, "/")).text()).find((a) => a.endsWith(".js"))!;
            const first = await get(s, js);
            const etag = first.headers.get("etag")!;
            expect(first.headers.get("cache-control")).toContain("immutable");
            const body = await first.text();
            const again = await get(s, js);
            expect(await again.text()).toBe(body);
            expect(again.headers.get("etag")).toBe(etag);
            const cond = await get(s, js, { headers: { "if-none-match": etag } });
            expect([cond.status, (await cond.text()).length]).toEqual([304, 0]);
            const head = await get(s, js, { method: "HEAD" });
            expect(head.status).toBe(200);
        });

        test("parameterised bundle routes and a wildcard route match like any route", async () => {
            const s = start({ backend, development: false, routes: { "/app/:id": page, "/docs/*": other } });
            expect((await get(s, "/app/42")).headers.get("content-type")).toContain("text/html");
            expect(await (await get(s, "/docs/a/b/c")).text()).toContain("<script");
            expect((await get(s, "/app")).status).toBe(404);
        });

        test("reload() swaps the bundle routes", async () => {
            const s = start({ backend, development: false, routes: { "/": page }, fetch: () => new Response("none", { status: 404 }) });
            expect(await (await get(s, "/")).text()).toContain("<script");
            s.reload({ routes: { "/": () => new Response("plain now") } });
            expect(await (await get(s, "/")).text()).toBe("plain now");
            s.reload({ routes: { "/new": other } });
            expect(await (await get(s, "/new")).text()).toContain("<script");
            expect((await get(s, "/")).status).toBe(404);
        });

        test("stop() stops watching and serving", async () => {
            const s = start({ backend, routes: { "/": page } });
            await get(s, "/");
            await s.stop(true);
            const err = await get(s, "/").then(() => null, (e) => e);
            expect(err).not.toBeNull();
        });

        test("development: the page loads the dev client, which the engine serves", async () => {
            const s = start({ backend, development: { hmr: true, console: true }, routes: { "/": page } });
            const html = await (await get(s, "/")).text();
            expect(html).toContain('<script src="/_archlast/dev.js"></script>');
            const js = await get(s, "/_archlast/dev.js");
            expect(js.headers.get("content-type")).toContain("javascript");
            const text = await js.text();
            expect(text).toContain("/_archlast/dev");
            expect(text).toContain("console"); // console forwarding is on
            const quiet = start({ backend, development: { hmr: true }, routes: { "/": page } });
            expect(await (await get(quiet, "/_archlast/dev.js")).text()).not.toContain("unhandledrejection");
            const prod = start({ backend, development: false, routes: { "/": page } });
            expect(await (await get(prod, "/")).text()).not.toContain("_archlast");
            expect((await get(prod, "/_archlast/dev.js")).status).toBe(404);
        });

        test("development: an edit rebuilds and tells open pages to reload; a broken edit shows the error and keeps the last good build", async () => {
            const dir = mkdtempSync(join(tmpdir(), "archlast-site-"));
            try {
                cpSync(join(import.meta.dir, "fixtures/site"), dir, { recursive: true });
                const live = (await import(join(dir, "index.html"))).default;
                const s = start({ backend, development: { hmr: true }, routes: { "/": live } });
                const script = async () => {
                    const html = await (await get(s, "/")).text();
                    const src = assetsOf(html).find((a) => a.endsWith(".js") && !a.includes("_archlast"))!;
                    return await (await get(s, src)).text();
                };
                expect(await script()).toContain("SITE_MARKER_ONE");
                const ws = new WebSocket(`ws://127.0.0.1:${s.port}/_archlast/dev`);
                const msgs: any[] = [];
                const next = async (pred: (m: any) => boolean) => {
                    for (let i = 0; i < 100; i++) {
                        const hit = msgs.find(pred);
                        if (hit) return hit;
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    throw new Error("no matching message; got " + JSON.stringify(msgs));
                };
                ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
                await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("dev socket failed")); });

                writeFileSync(join(dir, "lib.ts"), "export const greet = (n: string) => `changed ${n}`;");
                await next((m) => m.t === "reload");
                expect(await script()).toContain("changed");

                msgs.length = 0;
                const logged = console.error;
                console.error = () => {}; // the server reports the build failure it is meant to hit
                writeFileSync(join(dir, "lib.ts"), "export const greet = (n: string) => {{{ broken");
                const err = await next((m) => m.t === "error").finally(() => { console.error = logged; });
                expect(err.message.length).toBeGreaterThan(0);
                expect(await script()).toContain("changed"); // the last good build still serves

                msgs.length = 0;
                writeFileSync(join(dir, "lib.ts"), "export const greet = (n: string) => `fixed ${n}`;");
                await next((m) => m.t === "reload");
                expect(await script()).toContain("fixed");
                ws.close();
            } finally {
                servers.forEach((x) => void x.stop(true)); // stop watching before the folder goes
                rmSync(dir, { recursive: true, force: true });
            }
        }, 20_000);

        test("development: console messages from the page are printed by the server", async () => {
            const s = start({ backend, development: { console: true }, routes: { "/": page } });
            const seen: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => void seen.push(a.join(" "));
            try {
                const ws = new WebSocket(`ws://127.0.0.1:${s.port}/_archlast/dev`);
                await new Promise<void>((res) => (ws.onopen = () => res()));
                ws.send(JSON.stringify({ t: "console", level: "log", text: "from the browser 42" }));
                for (let i = 0; i < 40 && !seen.some((l) => l.includes("from the browser 42")); i++) await new Promise((r) => setTimeout(r, 25));
                ws.close();
            } finally {
                console.log = orig;
            }
            expect(seen).toContain("[browser] from the browser 42");
        });

        test("non-bundle servers never start a bundler", async () => {
            const s = start({ backend, routes: { "/": () => new Response("x") } });
            expect(await (await get(s, "/")).text()).toBe("x");
            expect((await get(s, "/_archlast/dev.js")).status).toBe(404);
        });
    });
}

const chromium = spawnSync("which", ["chromium"]).status === 0 ? "chromium" : null;

/** A real browser loads the page from a separate process running the engine, so its stdout can be inspected. */
describe.skipIf(!chromium)("HTML bundles in a real browser", () => {
    for (const mode of ["prod", "dev"] as const) {
        test(`${mode}: the bundled script runs${mode === "dev" ? " and console.log reaches the server's output" : ""}`, async () => {
            const child = spawn("bun", [join(import.meta.dir, "fixtures/site-server.ts"), mode], { stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            child.stdout.on("data", (d) => (out += d));
            child.stderr.on("data", (d) => (out += d));
            try {
                let port = "";
                for (let i = 0; i < 100 && !port; i++) {
                    await new Promise((r) => setTimeout(r, 50));
                    port = /PORT (\d+)/.exec(out)?.[1] ?? "";
                }
                expect(port).not.toBe("");
                const dom = spawnSync(chromium!, ["--headless=new", "--no-sandbox", "--disable-gpu", "--timeout=7000", "--dump-dom", `http://127.0.0.1:${port}/`], { encoding: "utf8", timeout: 30000 });
                expect(dom.stdout).toContain('<div id="app">hello SITE_MARKER_ONE</div>');
                if (mode === "dev") {
                    const plain = () => out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
                    for (let i = 0; i < 80 && !plain().includes("[browser] BROWSER_LOG_MARKER"); i++) await new Promise((r) => setTimeout(r, 100));
                    expect(plain()).toContain("[browser] BROWSER_LOG_MARKER");
                }
            } finally {
                child.kill();
            }
        }, 60000);
    }
});
