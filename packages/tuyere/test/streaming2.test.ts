import { afterAll, describe, expect, test } from "bun:test";
import {
  App,
  Stream,
  sse,
  type BackendName,
  type Server,
} from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw request; returns everything received until the server closes the connection or `maxMs` passes. */
function rawGet(
  port: number,
  path: string,
  maxMs = 1500,
  extra = "",
): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (closed: boolean) => {
      if (!done) {
        done = true;
        resolve({ data, closed });
      }
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (s) =>
          void s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`),
        data: (_s, d) => void (data += Buffer.from(d).toString("latin1")),
        close: () => finish(true),
        error: () => finish(true),
      },
    }).catch(() => finish(true));
    setTimeout(() => finish(false), maxMs);
  });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`streaming responses, part 2: ${backend}`, () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.stop()));
    const track = (s: Server) => (servers.push(s), s);
    let cancelled = 0;

    const app = () =>
      new App()
        .get("/broken", () => {
          const st = new Stream();
          st.write("partial");
          setTimeout(() => st.error(), 60);
          return st;
        })
        .get("/rs", () => {
          let i = 0,
            t: any;
          return new Response(
            new ReadableStream({
              start(c) {
                t = setInterval(() => {
                  c.enqueue(new TextEncoder().encode(`chunk${i++};`));
                  if (i === 3) (clearInterval(t), c.close());
                }, 120);
              },
              cancel() {
                clearInterval(t);
                cancelled++;
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        })
        .get(
          "/rs-fails",
          () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode("first;"));
                  setTimeout(() => c.error(new Error("producer failed")), 80);
                },
              }),
            ),
        )
        .get(
          "/finite",
          () => new Response("hello", { status: 201, headers: { "x-a": "1" } }),
        )
        .get("/finite-json", () => Response.json({ ok: true }))
        .get(
          "/big",
          () => new Response(new Uint8Array(3 * 1024 * 1024).fill(5)),
        )
        .get("/idle", () =>
          sse((st) => {
            st.send("hello");
            return () => void idleClosed++;
          }),
        )
        .get("/idle-count", () => ({ idleClosed }))
        .get("/hop", () => {
          const st = new Stream({
            headers: {
              "content-type": "text/event-stream",
              connection: "keep-alive",
              "cache-control": "no-cache",
            },
          });
          st.write("data: x\n\n");
          setTimeout(() => st.end(), 50);
          return st;
        })
        .onError(() => {});
    let idleClosed = 0;

    test("Stream.error() breaks the connection: no clean terminator reaches the client", async () => {
      const s = track(app().listen({ port: 0, backend }));
      const r = await rawGet(s.port, "/broken", 1500);
      expect(r.data).toContain("partial");
      expect(r.data.endsWith("0\r\n\r\n")).toBe(false); // a clean end would finish with the zero-length chunk
      expect(r.closed).toBe(true);
      await expect(
        (async () =>
          (await fetch(`http://127.0.0.1:${s.port}/broken`)).text())(),
      ).rejects.toThrow();
      expect(
        await (await fetch(`http://127.0.0.1:${s.port}/finite`)).text(),
      ).toBe("hello"); // still healthy
    });

    test("a ReadableStream body that is still producing is streamed incrementally, and cancel() reaches the producer", async () => {
      const s = track(app().listen({ port: 0, backend }));
      const t0 = performance.now();
      const r = await fetch(`http://127.0.0.1:${s.port}/rs`);
      const reader = r.body!.getReader();
      const first = await reader.read();
      expect(performance.now() - t0).toBeLessThan(230); // delivered as produced, not after the 360 ms it takes to finish
      expect(new TextDecoder().decode(first.value)).toBe("chunk0;");
      let all = "chunk0;";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        all += new TextDecoder().decode(value);
      }
      expect(all).toBe("chunk0;chunk1;chunk2;");
      const ctrl = new AbortController();
      const r2 = await fetch(`http://127.0.0.1:${s.port}/rs`, {
        signal: ctrl.signal,
      });
      await r2.body!.getReader().read();
      ctrl.abort();
      for (let i = 0; i < 40 && cancelled === 0; i++) await sleep(25);
      expect(cancelled).toBeGreaterThan(0);
    });

    test("a body whose producer fails mid-way breaks the stream instead of ending cleanly", async () => {
      const s = track(app().listen({ port: 0, backend }));
      const r = await rawGet(s.port, "/rs-fails", 1500);
      expect(r.data).toContain("first;");
      expect(r.data.endsWith("0\r\n\r\n")).toBe(false);
    });

    test("finite Responses keep a content-length (not chunked), including JSON and 3 MiB bodies", async () => {
      const s = track(app().listen({ port: 0, backend }));
      let r = await rawGet(s.port, "/finite", 1500, "Connection: close\r\n");
      expect(r.data).toContain("HTTP/1.1 201");
      expect(r.data.toLowerCase()).toContain("content-length: 5");
      expect(r.data.toLowerCase()).not.toContain("transfer-encoding");
      expect(r.data).toContain("x-a: 1");
      r = await rawGet(s.port, "/finite-json", 1500, "Connection: close\r\n");
      expect(r.data.toLowerCase()).toContain("content-length: 11");
      const big = new Uint8Array(
        await (await fetch(`http://127.0.0.1:${s.port}/big`)).arrayBuffer(),
      );
      expect([big.length, big[0], big[big.length - 1]]).toEqual([
        3 * 1024 * 1024,
        5,
        5,
      ]);
    });

    test("a client leaving an idle stream (nothing in flight) is noticed", async () => {
      const s = track(app().listen({ port: 0, backend }));
      const ctrl = new AbortController();
      const r = await fetch(`http://127.0.0.1:${s.port}/idle`, {
        signal: ctrl.signal,
      });
      await r.body!.getReader().read(); // got "hello"; now the stream is silent
      await sleep(300);
      ctrl.abort();
      let n = 0;
      for (let i = 0; i < 40 && n === 0; i++) {
        await sleep(25);
        n = (
          (await (
            await fetch(`http://127.0.0.1:${s.port}/idle-count`)
          ).json()) as { idleClosed: number }
        ).idleClosed;
      }
      expect(n).toBe(1);
    });

    test("a handler-supplied 'connection: keep-alive' header (Nest's @Sse sends it) is harmless", async () => {
      const s = track(app().listen({ port: 0, backend }));
      const r = await fetch(`http://127.0.0.1:${s.port}/hop`);
      expect(await r.text()).toBe("data: x\n\n");
      expect(r.status).toBe(200);
    });
  });
}
