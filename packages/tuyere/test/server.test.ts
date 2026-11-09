import { afterAll, describe, expect, test } from "bun:test";
import {
  App,
  Reply,
  serve,
  type BackendName,
  type Server,
} from "../src/index.ts";

const backends: BackendName[] = ["bun-ffi", "napi"];

for (const backend of backends) {
  describe(`backend: ${backend}`, () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.stop()));
    const url = (s: Server, p: string) => `http://127.0.0.1:${s.port}${p}`;
    const track = (s: Server) => (servers.push(s), s);

    test("static, dynamic, params, query, 404", async () => {
      const s = track(
        new App()
          .get("/", "hello")
          .get("/json", { ok: true, n: 42 })
          .get("/dyn", () => ({ dyn: true }))
          .get("/user/:id/post/:pid", (c) => c.params)
          .get("/q", (c) => c.query)
          .listen({ port: 0, backend, threads: 2 }),
      );
      expect(s.backend).toBe(backend);
      let r = await fetch(url(s, "/"));
      expect([r.status, r.headers.get("content-type"), await r.text()]).toEqual(
        [200, "text/plain;charset=utf-8", "hello"],
      );
      r = await fetch(url(s, "/json"));
      expect([r.headers.get("content-type"), await r.json()]).toEqual([
        "application/json;charset=utf-8",
        { ok: true, n: 42 },
      ]);
      expect(await (await fetch(url(s, "/dyn"))).json()).toEqual({ dyn: true });
      expect(await (await fetch(url(s, "/user/7/post/a%20b"))).json()).toEqual({
        id: "7",
        pid: "a b",
      });
      expect(await (await fetch(url(s, "/q?a=1&b=x%26y"))).json()).toEqual({
        a: "1",
        b: "x&y",
      });
      r = await fetch(url(s, "/missing"));
      expect([r.status, await r.text()]).toEqual([404, "Not Found"]);
    });

    test("methods and request bodies (json, text, binary, large)", async () => {
      const s = track(
        new App()
          .post("/json", (c) => ({ got: c.body }))
          .put("/text", (c) => c.text().toUpperCase())
          .post("/len", async (c) => String((await c.readBytes()).length))
          .delete("/x", () => new Reply("gone", { status: 410 }))
          .listen({ port: 0, backend }),
      );
      expect(
        await (
          await fetch(url(s, "/json"), {
            method: "POST",
            body: JSON.stringify({ a: 1 }),
            headers: { "content-type": "application/json" },
          })
        ).json(),
      ).toEqual({ got: { a: 1 } });
      expect(
        await (
          await fetch(url(s, "/text"), { method: "PUT", body: "héllo" })
        ).text(),
      ).toBe("HÉLLO");
      const big = new Uint8Array(3 * 1024 * 1024).fill(7); // larger than the 256 KB inbox
      expect(
        await (
          await fetch(url(s, "/len"), { method: "POST", body: big })
        ).text(),
      ).toBe(String(big.length));
      const r = await fetch(url(s, "/x"), { method: "DELETE" });
      expect([r.status, await r.text()]).toEqual([410, "gone"]);
      expect((await fetch(url(s, "/json"))).status).toBe(404); // wrong method
    });

    test("status and headers via ctx.set and Reply, including multi-byte values", async () => {
      const s = track(
        new App()
          .get("/set", (c) => {
            c.set.status = 201;
            c.set.headers["x-one"] = "1";
            return { made: true };
          })
          .get(
            "/reply",
            () =>
              new Reply("<b>hi</b>", {
                headers: { "content-type": "text/html", "x-é": "ü" },
              }),
          )
          .get(
            "/cookie",
            () =>
              new Reply("c", {
                headers: [
                  ["set-cookie", "a=1"],
                  ["set-cookie", "b=2"],
                ],
              }),
          )
          .listen({ port: 0, backend }),
      );
      let r = await fetch(url(s, "/set"));
      expect([
        r.status,
        r.headers.get("x-one"),
        r.headers.get("content-type"),
        await r.json(),
      ]).toEqual([201, "1", "application/json;charset=utf-8", { made: true }]);
      r = await fetch(url(s, "/reply"));
      expect([r.headers.get("content-type"), await r.text()]).toEqual([
        "text/html",
        "<b>hi</b>",
      ]);
      r = await fetch(url(s, "/cookie"));
      expect(r.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    });

    test("request headers", async () => {
      const s = track(
        new App()
          .get("/h", (c) => ({
            ua: c.header("user-agent"),
            x: c.headers.get("X-Custom"),
            none: c.header("nope"),
          }))
          .listen({ port: 0, backend }),
      );
      const r = await fetch(url(s, "/h"), {
        headers: { "x-custom": "väl", "user-agent": "t/1" },
      });
      const j = (await r.json()) as Record<string, unknown>;
      expect(j.ua).toBe("t/1");
      expect(j.none).toBeNull();
      expect(typeof j.x).toBe("string");
    });

    test("async handlers and thrown errors", async () => {
      let reported: unknown = null;
      const s = track(
        new App()
          .get("/slow", async () => (await Bun.sleep(20), { slow: true }))
          .get("/throw", () => {
            throw new Error("boom");
          })
          .get("/reject", async () => {
            throw new Error("nope");
          })
          .onError((e) => (reported = e))
          .listen({ port: 0, backend }),
      );
      expect(await (await fetch(url(s, "/slow"))).json()).toEqual({
        slow: true,
      });
      let r = await fetch(url(s, "/throw"));
      expect([r.status, await r.text()]).toEqual([
        500,
        "Internal Server Error",
      ]);
      expect((reported as Error).message).toBe("boom");
      r = await fetch(url(s, "/reject"));
      expect(r.status).toBe(500);
      expect(await (await fetch(url(s, "/slow"))).json()).toEqual({
        slow: true,
      }); // still healthy afterwards
    });

    test("serve(): routes, per-method routes and a Bun-style fetch fallback", async () => {
      const s = track(
        serve({
          port: 0,
          backend,
          routes: {
            "/": "root",
            "/api": { GET: () => "got", POST: (c) => `posted:${c.text()}` },
          },
          fetch: async (req) => {
            const u = new URL(req.url);
            const body = req.method === "POST" ? await req.text() : "";
            return Response.json(
              {
                via: "fetch",
                path: u.pathname,
                search: u.search,
                method: req.method,
                body,
              },
              { status: 202, headers: { "x-f": "1" } },
            );
          },
        }),
      );
      expect(await (await fetch(url(s, "/"))).text()).toBe("root");
      expect(await (await fetch(url(s, "/api"))).text()).toBe("got");
      expect(
        await (
          await fetch(url(s, "/api"), { method: "POST", body: "abc" })
        ).text(),
      ).toBe("posted:abc");
      const r = await fetch(url(s, "/other?z=1"), {
        method: "POST",
        body: "data",
      });
      expect([r.status, r.headers.get("x-f"), await r.json()]).toEqual([
        202,
        "1",
        {
          via: "fetch",
          path: "/other",
          search: "?z=1",
          method: "POST",
          body: "data",
        },
      ]);
    });

    test("2000 concurrent requests all get their own response", async () => {
      const s = track(
        new App()
          .get("/n/:n", (c) => c.params.n)
          .get("/slowish/:n", async (c) =>
            Number(c.params.n) % 7 === 0
              ? (await Bun.sleep(5), c.params.n)
              : c.params.n,
          )
          .listen({ port: 0, backend, threads: 4 }),
      );
      for (const route of ["n", "slowish"]) {
        const results = await Promise.all(
          Array.from({ length: 2000 }, (_, i) =>
            fetch(url(s, `/${route}/${i}`)).then((r) => r.text()),
          ),
        );
        const wrong = results.filter((t, i) => t !== String(i));
        expect(wrong.length).toBe(0);
      }
    });

    test("stop() frees the port and is idempotent", async () => {
      const s = new App().get("/", "x").listen({ port: 0, backend });
      const port = s.port;
      expect((await fetch(url(s, "/"))).status).toBe(200);
      s.stop();
      s.stop();
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      const again = track(new App().get("/", "y").listen({ port, backend }));
      expect(await (await fetch(url(again, "/"))).text()).toBe("y");
    });

    test("binding an in-use port throws", () => {
      const a = track(
        new App()
          .get("/", "x")
          .listen({ port: 0, backend, hostname: "127.0.0.1" }),
      );
      expect(() =>
        new App().listen({ port: a.port, backend, hostname: "127.0.0.1" }),
      ).toThrow();
    });
  });
}
