import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MinimalResponse } from "../src/index";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const runtimeDir = join(import.meta.dir, "..");
const forgeDir = join(tempDir(), "forge");
const appRuntime = join(forgeDir, "node_modules", "@archlast", "forge-runtime");
const appEntry = join(appRuntime, "src", "index.ts");

beforeAll(async () => {
  cpSync(join(import.meta.dir, "fixture-runtime-copy"), forgeDir, {
    recursive: true,
    filter: (path) => !path.endsWith("tsconfig.json"), // its base config only exists in the repository
  });
  mkdirSync(appRuntime, { recursive: true });
  copyFileSync(join(runtimeDir, "package.json"), join(appRuntime, "package.json"));
  cpSync(join(runtimeDir, "src"), join(appRuntime, "src"), { recursive: true });
  // Only the runtime itself is duplicated. Its third-party dependencies can be shared.
  symlinkSync(join(runtimeDir, "node_modules"), join(appRuntime, "node_modules"), "dir");
  expect((await import(appEntry)).MinimalResponse).not.toBe(MinimalResponse);
});

for (const mode of ["inline", "process"] as const) {
  describe(`HTTP with a separate app runtime (${mode})`, () => {
    let server: RunningServer;
    const request = (path: string, init?: RequestInit) => fetch(server.url + path, init);

    beforeAll(async () => {
      server = await startServer({
        forgeDir,
        dev: false,
        env: {
          ...process.env,
          PORT: "0",
          DATA_DIR: tempDir(),
          BETTER_AUTH_SECRET: "s".repeat(32),
          ALLOW_INSECURE_HTTP: "1",
          HTTP_ENGINE: "bun",
          RUNTIME_MODE: mode,
          RUNTIME_WORKERS: "1",
          TELEMETRY: "off",
          MAX_REQUEST_BYTES: "1024",
          LOG_FORMAT: "json",
        },
      });
    });
    afterAll(() => server?.stop({ graceful: false }));

    test("the handler loads the separate runtime installation in the configured process", async () => {
      const res = await request("/runtime");
      expect(res.status).toBe(200);
      const info = (await res.json()) as { path: string; pid: number };
      expect(info.path).toBe(pathToFileURL(appEntry).href);
      expect(info.pid === process.pid).toBe(mode === "inline");
    });

    test("synchronous and asynchronous minimal responses keep status, type, body and both cookies", async () => {
      for (const cookie of [undefined, "example=1"]) {
        const headers = cookie ? { cookie } : undefined;
        const json = await request("/json", { headers });
        expect(json.status).toBe(201);
        expect(json.headers.get("content-type")).toBe("application/json");
        expect(json.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
        expect(await json.json()).toEqual({ created: true });

        const text = await request("/text");
        expect(text.status).toBe(200);
        expect(text.headers.get("content-type")).toBe("text/plain;charset=utf-8");
        expect(await text.text()).toBe("héllo");
      }
    });

    if (mode === "inline") {
      test("the direct path answers a synchronous minimal handler without a promise", () => {
        const answer = server.runtime.inlineWorker()!.httpDirect({
          t: "http",
          req: { method: "GET", url: server.url + "/json", path: "/json", search: "", headers: [] },
          headers: {},
        });
        expect(answer).not.toBeInstanceOf(Promise);
        expect(answer).toMatchObject({ status: 201, body: '{"created":true}' });
      });
    }

    test("raw minimal responses keep their bytes, empty statuses and redirect location", async () => {
      const binary = await request("/binary");
      expect(binary.status).toBe(200);
      expect(binary.headers.get("content-type")).toBe("application/octet-stream");
      expect(await binary.bytes()).toEqual(new Uint8Array([0, 255, 128, 10]));

      const empty = await request("/empty");
      expect([empty.status, empty.headers.get("x-empty"), await empty.text()]).toEqual([204, "yes", ""]);
      const cached = await request("/cached");
      expect([cached.status, cached.headers.get("etag"), await cached.text()]).toEqual([304, '"v1"', ""]);
      const redirect = await request("/redirect", { redirect: "manual" });
      expect([redirect.status, redirect.headers.get("location"), await redirect.text()]).toEqual([307, "/text", ""]);
    });

    test("minimal handlers can still return native responses, including streams", async () => {
      const native = await request("/native");
      expect([native.status, native.headers.get("x-native"), await native.text()]).toEqual([202, "yes", "native"]);

      try {
        const streamed = await request("/stream", { signal: AbortSignal.timeout(3_000) });
        expect(streamed.headers.get("content-type")).toBe("text/event-stream");
        const reader = streamed.body!.pipeThrough(new TextDecoderStream()).getReader();
        expect(await reader.read()).toMatchObject({ value: "data: first\n\n", done: false });
        expect((await request("/finish-stream")).status).toBe(204);
        expect(await reader.read()).toMatchObject({ value: "data: last\n\n", done: false });
        expect((await reader.read()).done).toBe(true);
      } finally {
        await request("/finish-stream");
      }
    });

    test("Nest JSON and webhook responses retain configured security headers, CORS and request limits", async () => {
      const origin = "https://app.example";
      const ping = await request("/api/ping", { headers: { origin } });
      expect(ping.status).toBe(200);
      expect(ping.headers.get("content-type")).toContain("application/json");
      expect(ping.headers.get("x-content-type-options")).toBe("nosniff");
      expect(ping.headers.get("referrer-policy")).toBe("same-origin");
      expect(ping.headers.get("access-control-allow-origin")).toBe(origin);
      expect(ping.headers.get("access-control-allow-credentials")).toBe("true");
      expect(await ping.json()).toEqual({ ok: true });

      const webhook = (event: string) =>
        request("/api/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": "webhook-1" },
          body: JSON.stringify({ event }),
        });
      const ack = await webhook("updated");
      expect(ack.status).toBe(202);
      expect(ack.headers.get("x-request-id")).toBe("webhook-1");
      expect(await ack.json()).toEqual({ received: "updated" });
      expect((await webhook("x".repeat(1024))).status).toBe(413);
    });

    test("invalid results and thrown errors are sanitized in production", async () => {
      for (const path of ["/invalid", "/throws"]) {
        const res = await request(path, { headers: { "x-request-id": "runtime-copy-error" } });
        expect(res.status).toBe(500);
        expect(res.headers.get("x-request-id")).toBe("runtime-copy-error");
        const body = await res.text();
        expect(body).toContain("Server error (request runtime-copy-error)");
        expect(body).not.toMatch(/must return a Response|internal fixture detail/);
      }
    });
  });
}
