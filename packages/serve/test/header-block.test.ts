import { afterAll, describe, expect, test } from "bun:test";
import { defaultBackend } from "../src/backend.ts";
import { type CompatServer, serveCompat } from "../src/compat.ts";
import { HeaderBlock, Reply } from "../src/index.ts";

const servers: CompatServer<any>[] = [];
afterAll(() => servers.forEach((s) => void s.stop(true)));

const block = new HeaderBlock([
  ["X-Frame-Options", "DENY"],
  ["Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"],
  ["X-Note", "kept"],
]);

describe("a Reply with a block of headers encoded ahead of time", () => {
  test("sends them with the headers it has of its own, on every answer", async () => {
    const s = serveCompat({ port: 0, backend: defaultBackend(), fetch: () => new Reply("hi", { status: 201, headers: { "x-own": "1", "content-type": "text/plain" }, block }) as unknown as Response });
    servers.push(s);
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`http://127.0.0.1:${s.port}/`);
      expect(r.status).toBe(201);
      expect(await r.text()).toBe("hi");
      expect(r.headers.get("x-own")).toBe("1");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(r.headers.get("x-note")).toBe("kept"); // names are lower-cased
    }
  });

  test("a Reply without one is as it was", async () => {
    const s = serveCompat({ port: 0, backend: defaultBackend(), fetch: () => new Reply("plain", { headers: { "x-a": "b" } }) as unknown as Response });
    servers.push(s);
    const r = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(r.headers.get("x-a")).toBe("b");
    expect(r.headers.get("x-frame-options")).toBeNull();
  });
});
