import { afterAll, describe, expect, test } from "bun:test";
import { cacheHeader } from "../src/cache.ts";
import { type CompatServer, serveCompat } from "../src/compat.ts";
import type { BackendName } from "../src/index.ts";

const servers: CompatServer<any>[] = [];
afterAll(() => servers.forEach((s) => void s.stop(true)));
const html = "<!doctype html><title>x</title>" + "<p>hello</p>".repeat(100);

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`response cache: ${backend}`, () => {
    /** A server whose handler counts its calls and answers `rules` (or nothing to cache). */
    function start(rules: Parameters<typeof cacheHeader>[0] | null, o: { status?: number; headers?: Record<string, string> } = {}) {
      let calls = 0;
      const s = serveCompat({
        port: 0,
        backend,
        fetch(req) {
          calls++;
          const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "x-call": String(calls), ...o.headers };
          if (rules) headers["x-archlast-cache"] = cacheHeader(rules);
          return new Response(req.method === "HEAD" ? null : html, { status: o.status ?? 200, headers });
        },
      });
      servers.push(s);
      return { s, calls: () => calls, get: (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => fetch(`http://127.0.0.1:${s.port}${path}`, { headers: { "accept-encoding": "identity", ...headers }, ...init }) };
    }

    test("a response that asks is answered again without running the handler; the note itself is never sent", async () => {
      const t = start({ ttl: 30 });
      const a = await t.get("/p");
      expect(a.headers.get("x-archlast-cache")).toBeNull();
      expect(await a.text()).toBe(html);
      const b = await t.get("/p");
      expect(b.headers.get("x-call")).toBe("1"); // the first response's own header: a copy of it
      expect(await b.text()).toBe(html);
      expect(t.calls()).toBe(1);
      expect(b.headers.get("etag")).toBeTruthy();
      expect(b.headers.get("x-archlast-cache")).toBeNull();
    });

    test("a response that does not ask is not kept", async () => {
      const t = start(null);
      await t.get("/p");
      await t.get("/p");
      expect(t.calls()).toBe(2);
    });

    test("path and query are the key; HEAD is answered from the entry; other methods run the handler", async () => {
      const t = start({ ttl: 30 });
      await t.get("/p?a=1");
      await t.get("/p?a=2");
      expect(t.calls()).toBe(2);
      await t.get("/p?a=1");
      expect(t.calls()).toBe(2);
      const head = await t.get("/p?a=1", {}, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(t.calls()).toBe(2);
      await t.get("/p?a=1", {}, { method: "POST", body: "x" });
      expect(t.calls()).toBe(3);
    });

    test("varied cookies make separate entries; any other cookie, or a skipped header, bypasses the cache", async () => {
      const t = start({ ttl: 30, varyCookie: ["tz"], onlyCookie: ["consent"], skipHeader: ["authorization"] });
      await t.get("/p", { cookie: "tz=UTC" });
      await t.get("/p", { cookie: "tz=UTC" });
      expect(t.calls()).toBe(1);
      await t.get("/p", { cookie: "tz=Asia/Manila" });
      expect(t.calls()).toBe(2);
      await t.get("/p", { cookie: "tz=UTC; consent=1" }); // an allowed cookie that is not varied: same entry
      expect(t.calls()).toBe(2);
      await t.get("/p", { cookie: "tz=UTC; session=abc" });
      await t.get("/p", { cookie: "tz=UTC; session=abc" });
      expect(t.calls()).toBe(4); // never cached, never served from the cache
      await t.get("/p", { cookie: "tz=UTC", authorization: "Bearer x" });
      expect(t.calls()).toBe(5);
    });

    test("a response that sets a cookie, says no-store, or is not a 200 is not kept", async () => {
      for (const o of [{ headers: { "set-cookie": "a=b" } }, { headers: { "cache-control": "no-store" } }, { status: 404 }] as { status?: number; headers?: Record<string, string> }[]) {
        const t = start({ ttl: 30 }, o);
        await t.get("/p");
        await t.get("/p");
        expect(t.calls()).toBe(2);
      }
    });

    test("gzip for clients that take it, identity for those that do not, and a 304 for a matching If-None-Match", async () => {
      const t = start({ ttl: 30 });
      await t.get("/p");
      const gz = await t.get("/p", { "accept-encoding": "gzip, br" });
      expect(gz.headers.get("content-encoding")).toBe("gzip");
      expect(gz.headers.get("vary")).toContain("accept-encoding");
      expect(await gz.text()).toBe(html); // fetch has already decoded it, so the gzip was a valid one
      const plain = await t.get("/p");
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(await plain.text()).toBe(html);
      const etag = plain.headers.get("etag")!;
      const nm = await t.get("/p", { "if-none-match": etag });
      expect(nm.status).toBe(304);
      expect(t.calls()).toBe(1);
    });

    test("an entry lives for its ttl", async () => {
      const t = start({ ttl: 1 });
      await t.get("/p");
      await t.get("/p");
      expect(t.calls()).toBe(1);
      await new Promise((r) => setTimeout(r, 1200));
      await t.get("/p");
      expect(t.calls()).toBe(2);
    });

    test("purgeCache drops entries by tag, or all of them", async () => {
      const a = start({ ttl: 30, tags: ["posts"] });
      await a.get("/p");
      a.s.purgeCache(["other"]);
      await a.get("/p");
      expect(a.calls()).toBe(1);
      a.s.purgeCache(["posts"]);
      await new Promise((r) => setTimeout(r, 50)); // the command travels in the next batch
      await a.get("/p");
      expect(a.calls()).toBe(2);
      a.s.purgeCache();
      await new Promise((r) => setTimeout(r, 50));
      await a.get("/p");
      expect(a.calls()).toBe(3);
    });

    test("cacheHeader refuses a ttl that is not above 0", () => {
      expect(() => cacheHeader({ ttl: 0 })).toThrow(/ttl/);
      expect(cacheHeader({ ttl: 30, varyCookie: ["a", "b"], tags: ["t"] })).toBe("ttl=30; vary-cookie=a,b; tag=t");
    });
  });
}
