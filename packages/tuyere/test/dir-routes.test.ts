import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCompat } from "../src/compat.ts";
import type { BackendName } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "archlast-dir-"));
const outside = mkdtempSync(join(tmpdir(), "archlast-outside-"));
beforeAll(() => {
  mkdirSync(join(root, "pub", "sub"), { recursive: true });
  mkdirSync(join(root, "pub", "docs"), { recursive: true });
  writeFileSync(join(root, "pub", "a.txt"), "hello a");
  writeFileSync(join(root, "pub", "big.bin"), "0123456789");
  writeFileSync(join(root, "pub", "sub", "b.html"), "<p>b</p>");
  writeFileSync(join(root, "pub", "docs", "index.html"), "<h1>docs</h1>");
  writeFileSync(join(root, "pub", "has space.txt"), "spaced");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(root, "pub", "leak.txt"));
  symlinkSync(join(root, "pub", "a.txt"), join(root, "pub", "alias.txt")); // inside the tree: fine
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** One request with the target exactly as written (fetch would normalize it). */
function raw(
  port: number,
  target: string,
  method = "GET",
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () =>
      s.write(
        `${method} ${target} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`,
      ),
    );
    let data = "";
    s.on("data", (d: Buffer) => (data += d));
    s.on("error", reject);
    s.on("close", () => {
      const [head = "", body = ""] = data.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), head, body });
    });
  });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`{ dir } routes: ${backend}`, () => {
    const server = () =>
      serveCompat({
        port: 0,
        backend,
        routes: {
          "/static/*": { dir: join(root, "pub") },
          "/exact": new Response("exact"),
        },
        fetch: () => new Response("fallback", { status: 418 }),
      });
    let s: ReturnType<typeof server>;
    beforeAll(() => void (s = server()));
    afterAll(() => void s.stop(true));
    const get = (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${s.port}${path}`, {
        redirect: "manual",
        ...init,
      });

    test("serves files with their type, validators and ranges", async () => {
      const r = await get("/static/a.txt");
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("hello a");
      expect(r.headers.get("content-type")).toContain("text/plain");
      expect(r.headers.get("etag")).toBeTruthy();
      expect(r.headers.get("last-modified")).toBeTruthy();
      expect(
        (await get("/static/sub/b.html")).headers.get("content-type"),
      ).toContain("text/html");
      const part = await get("/static/big.bin", {
        headers: { range: "bytes=2-5" },
      });
      expect(part.status).toBe(206);
      expect(await part.text()).toBe("2345");
      const etag = r.headers.get("etag")!;
      expect(
        (await get("/static/a.txt", { headers: { "if-none-match": etag } }))
          .status,
      ).toBe(304);
    });

    test("HEAD has the headers and no body; other methods are 405", async () => {
      const h = await get("/static/a.txt", { method: "HEAD" });
      expect(h.status).toBe(200);
      expect(h.headers.get("content-length")).toBe("7");
      expect(await h.text()).toBe("");
      expect(
        (await get("/static/a.txt", { method: "POST", body: "x" })).status,
      ).toBe(405);
    });

    test("a directory redirects to its trailing slash, which serves index.html", async () => {
      const r = await get("/static/docs?x=1");
      expect(r.status).toBe(301);
      expect(r.headers.get("location")).toBe("/static/docs/?x=1");
      expect(await (await get("/static/docs/")).text()).toBe("<h1>docs</h1>");
      expect((await get("/static/sub/")).status).toBe(404); // no index.html there
      expect((await get("/static/")).status).toBe(404);
    });

    test("missing files are 404; the route needs its prefix; other routes still answer", async () => {
      expect((await get("/static/nope.txt")).status).toBe(404);
      expect((await get("/static/a.txt/")).status).toBe(404);
      expect((await get("/static")).status).toBe(418); // not under the prefix: the fetch handler
      expect(await (await get("/exact")).text()).toBe("exact");
    });

    test("a decoded name is served once; spaces work", async () => {
      expect(await (await get("/static/has%20space.txt")).text()).toBe(
        "spaced",
      );
    });

    test("non-canonical paths are 404", async () => {
      for (const target of [
        "/static/a%2Ftxt",
        "/static/sub%2Fb.html",
        "/static/%61.txt",
        "/static/a%2Etxt",
        "/static//a.txt",
        "/static/sub//b.html",
        "/static/..%2Fsecret",
        "/static/a.txt%00",
        "/static/%5Ca.txt",
      ]) {
        const r = await raw(s.port, target);
        expect([target, r.status]).toEqual([target, 404]);
      }
    });

    test("dot segments are resolved before routing, so they can never name a file outside the matched prefix", async () => {
      // The engine builds the URL the way a browser does ("/static/sub/%2e%2e/a.txt" is "/static/a.txt"); what matched is what is served.
      expect(await (await raw(s.port, "/static/sub/%2e%2e/a.txt")).body).toBe(
        "hello a",
      );
      const out = await raw(s.port, "/static/%2e%2e/%2e%2e/etc/passwd");
      expect(out.body).not.toContain("root:");
      expect(out.status).not.toBe(200);
    });

    test("a symlink inside the tree works; one that leaves it is 404", async () => {
      expect(await (await get("/static/alias.txt")).text()).toBe("hello a");
      expect((await get("/static/leak.txt")).status).toBe(404);
    });

    test("the route must end in /*", () => {
      expect(() =>
        serveCompat({
          port: 0,
          backend,
          routes: { "/static": { dir: root } },
          fetch: () => new Response("x"),
        }),
      ).toThrow(/\/\*/);
    });
  });
}
