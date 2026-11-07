import { afterAll, describe, expect, test } from "bun:test";
import {
  App,
  html,
  json,
  noContent,
  redirect,
  serve,
  status,
  text,
  type BackendName,
  type Server,
} from "../src/index.ts";

/** Sends raw bytes and returns everything the server wrote until it closes the connection (or 1.5 s). */
function raw(
  port: number,
  request: string,
): Promise<{
  status: number;
  headers: Map<string, string[]>;
  head: string;
  body: string;
}> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const i = data.indexOf("\r\n\r\n");
      const head = i === -1 ? data : data.slice(0, i);
      const lines = head.split("\r\n");
      const headers = new Map<string, string[]>();
      for (const l of lines.slice(1)) {
        const k = l.slice(0, l.indexOf(":")).toLowerCase();
        headers.set(k, [
          ...(headers.get(k) ?? []),
          l.slice(l.indexOf(":") + 1).trim(),
        ]);
      }
      resolve({
        status: Number(lines[0].split(" ")[1]),
        headers,
        head,
        body: i === -1 ? "" : data.slice(i + 4),
      });
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (s) => void s.write(request),
        data: (_s, d) => void (data += Buffer.from(d).toString("latin1")),
        close: finish,
        error: finish,
      },
    }).catch(finish);
    setTimeout(finish, 1500);
  });
}

const req = (method: string, path: string, body?: string, extra = "") =>
  `${method} ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${body !== undefined ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}${extra}\r\n${body ?? ""}`;

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`methods and status codes: ${backend}`, () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.stop()));
    const track = (s: Server) => (servers.push(s), s);

    test("every standard and custom method reaches its handler together with its body", async () => {
      const s = track(
        new App()
          .all("/m", (c) => ({
            method: c.method,
            body: c.text(),
            path: c.path,
          }))
          .listen({ port: 0, backend }),
      );
      for (const method of [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "PURGE",
        "PROPFIND",
        "MKCOL",
        "REPORT",
        "LOCK",
        "M-SEARCH",
      ]) {
        const body =
          method === "GET" || method === "OPTIONS"
            ? undefined
            : `payload for ${method}`;
        const r = await raw(s.port, req(method, "/m", body));
        expect([method, r.status]).toEqual([method, 200]);
        expect(JSON.parse(r.body)).toEqual({
          method,
          body: body ?? "",
          path: "/m",
        });
      }
      const t = await raw(s.port, req("TRACE", "/m"));
      expect([t.status, JSON.parse(t.body).method]).toEqual([200, "TRACE"]);
    });

    test("method shortcuts and .on() route to the right handler; a method-specific route beats .all()", async () => {
      const s = track(
        new App()
          .get("/r", "get")
          .post("/r", "post")
          .put("/r", "put")
          .patch("/r", "patch")
          .delete("/r", "delete")
          .options("/r", "options")
          .trace("/r", "trace")
          .on("purge", "/r", "purge")
          .on("PROPFIND", "/r", () => "propfind")
          .all("/r", () => "fallback")
          .listen({ port: 0, backend }),
      );
      for (const m of [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "TRACE",
        "PURGE",
        "PROPFIND",
      ]) {
        expect([
          m,
          (
            await raw(
              s.port,
              req(
                m,
                "/r",
                m === "GET" || m === "OPTIONS" || m === "TRACE"
                  ? undefined
                  : "",
              ),
            )
          ).body,
        ]).toEqual([m, m.toLowerCase()]);
      }
      expect((await raw(s.port, req("MKCOL", "/r", ""))).body).toBe("fallback");
    });

    test("serve({routes}) accepts any known method as a key", async () => {
      const s = track(
        serve({
          port: 0,
          backend,
          routes: {
            "/x": {
              GET: () => "g",
              PURGE: () => "p",
              PROPFIND: () => "pf",
              DELETE: () => "d",
            },
          },
        }),
      );
      for (const [m, want] of [
        ["GET", "g"],
        ["PURGE", "p"],
        ["PROPFIND", "pf"],
        ["DELETE", "d"],
      ])
        expect(
          (await raw(s.port, req(m, "/x", m === "GET" ? undefined : ""))).body,
        ).toBe(want);
    });

    test("CONNECT reaches a handler with the authority as its target", async () => {
      const s = track(
        new App()
          .connect("example.com:443", (c) => ({
            target: c.url,
            method: c.method,
          }))
          .all("/p", (() => "x") as never)
          .listen({ port: 0, backend }),
      );
      const r = await raw(
        s.port,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nConnection: close\r\n\r\n",
      );
      expect(r.head.startsWith("HTTP/1.1 ")).toBe(true); // a response arrives (hyper treats CONNECT as an upgrade candidate)
    });

    test("a wide range of status codes is returned exactly, with correct body and length rules", async () => {
      const s = track(
        new App()
          .get("/s/:code", (c) =>
            status(Number(c.params.code), `body-${c.params.code}`),
          )
          .listen({ port: 0, backend }),
      );
      const codes = [
        200, 201, 202, 203, 206, 207, 208, 226, 300, 301, 302, 303, 305, 307,
        308, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412,
        413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429,
        431, 451, 500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511, 599,
        999,
      ];
      for (const code of codes) {
        const r = await raw(s.port, req("GET", `/s/${code}`));
        expect([
          code,
          r.status,
          r.body,
          r.headers.get("content-length")?.[0],
        ]).toEqual([code, code, `body-${code}`, String(`body-${code}`.length)]);
      }
      for (const code of [204, 304]) {
        const r = await raw(s.port, req("GET", `/s/${code}`));
        expect([
          code,
          r.status,
          r.body,
          r.headers.has("content-length"),
          r.headers.has("content-type"),
        ]).toEqual([code, code, "", false, false]);
      }
      const r205 = await raw(s.port, req("GET", "/s/205"));
      expect([
        r205.status,
        r205.body,
        r205.headers.get("content-length")?.[0],
      ]).toEqual([205, "", "0"]);
    });

    test("invalid statuses are rejected (the client sees a 500, the server keeps serving)", async () => {
      expect(() => status(100)).toThrow(RangeError);
      expect(() => status(199)).toThrow(RangeError);
      expect(() => status(1000)).toThrow(RangeError);
      expect(() => status(200.5)).toThrow(RangeError);
      expect(() => status(NaN)).toThrow(RangeError);
      const s = track(
        new App()
          .get("/bad", () => status(100))
          .get("/ok", "ok")
          .onError(() => {})
          .listen({ port: 0, backend }),
      );
      expect((await raw(s.port, req("GET", "/bad"))).status).toBe(500);
      expect((await raw(s.port, req("GET", "/ok"))).body).toBe("ok");
    });

    test("response helpers set status, headers and content types", async () => {
      const s = track(
        new App()
          .get("/json", () =>
            json({ a: 1 }, { status: 201, headers: { "x-h": "1" } }),
          )
          .get("/text", () => text("t", { status: 202 }))
          .get("/html", () => html("<p>h</p>"))
          .get("/nc", () => noContent())
          .get("/r", () => redirect("/target"))
          .get("/r308", () =>
            redirect("/t", 308, { headers: { "cache-control": "no-store" } }),
          )
          .get("/r301", () => redirect("/t", 301))
          .get("/own-ct", () =>
            json(
              { b: 2 },
              { headers: { "Content-Type": "application/vnd.api+json" } },
            ),
          )
          .get("/bad-r", () => redirect("/x\r\nSet-Cookie: pwned=1"))
          .onError(() => {})
          .listen({ port: 0, backend }),
      );
      let r = await raw(s.port, req("GET", "/json"));
      expect([
        r.status,
        r.headers.get("content-type")?.[0],
        r.headers.get("x-h")?.[0],
        r.body,
      ]).toEqual([201, "application/json;charset=utf-8", "1", '{"a":1}']);
      r = await raw(s.port, req("GET", "/text"));
      expect([r.status, r.headers.get("content-type")?.[0]]).toEqual([
        202,
        "text/plain;charset=utf-8",
      ]);
      r = await raw(s.port, req("GET", "/html"));
      expect(r.headers.get("content-type")?.[0]).toBe(
        "text/html;charset=utf-8",
      );
      r = await raw(s.port, req("GET", "/nc"));
      expect([r.status, r.body, r.headers.has("content-length")]).toEqual([
        204,
        "",
        false,
      ]);
      r = await raw(s.port, req("GET", "/r"));
      expect([r.status, r.headers.get("location")?.[0], r.body]).toEqual([
        302,
        "/target",
        "",
      ]);
      r = await raw(s.port, req("GET", "/r308"));
      expect([
        r.status,
        r.headers.get("location")?.[0],
        r.headers.get("cache-control")?.[0],
      ]).toEqual([308, "/t", "no-store"]);
      expect((await raw(s.port, req("GET", "/r301"))).status).toBe(301);
      r = await raw(s.port, req("GET", "/own-ct"));
      expect(r.headers.get("content-type")).toEqual([
        "application/vnd.api+json",
      ]); // a caller-supplied type wins and is not duplicated
      r = await raw(s.port, req("GET", "/bad-r"));
      expect([r.status, r.headers.has("set-cookie")]).toEqual([500, false]); // header injection is refused
    });

    test("multiple Set-Cookie headers stay separate on the wire", async () => {
      const s = track(
        new App()
          .get("/c", () =>
            status(200, "x", {
              headers: [
                ["set-cookie", "a=1; Path=/"],
                ["set-cookie", "b=2; HttpOnly"],
              ],
            }),
          )
          .listen({ port: 0, backend }),
      );
      const r = await raw(s.port, req("GET", "/c"));
      expect(r.headers.get("set-cookie")).toEqual([
        "a=1; Path=/",
        "b=2; HttpOnly",
      ]);
    });
  });
}
