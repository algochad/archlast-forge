import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { nativeEngine } from "../src/server/engine";
import type { HttpResponseMessage } from "../src/server/protocol";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const baseEnv = {
  ...process.env,
  PORT: "0",
  DATA_DIR: undefined,
  BETTER_AUTH_SECRET: "s".repeat(32),
  ALLOW_INSECURE_HTTP: "1",
  RUNTIME_WORKERS: "1",
  RATE_LIMIT_PER_MINUTE: "0",
  API_DOCS: "off",
  TELEMETRY: "off",
};
const fixture = join(import.meta.dir, "fixture");
const canUseNative = Boolean(await nativeEngine());

for (const engine of ["bun", "archlast"] as const) {
  describe.skipIf(engine === "archlast" && !canUseNative)(`HTTP response boundaries (${engine})`, () => {
    let server: RunningServer;
    beforeAll(async () => {
      server = await startServer({ forgeDir: fixture, env: { ...baseEnv, DATA_DIR: tempDir(), HTTP_ENGINE: engine, RUNTIME_MODE: "inline" } });
    });
    afterAll(() => server?.stop({ graceful: false }));

    test("a reusable response gets just the current request id and keeps both cookies", async () => {
      for (const requestId of ["first-request", "second-request"]) {
        const res = await fetch(server.url + "/http/reused", { headers: { "x-request-id": requestId } });
        expect(res.headers.get("x-request-id")).toBe(requestId);
        expect(res.headers.getSetCookie()).toEqual(["one=1", "two=2"]);
        expect(await res.text()).toBe("reused");

        const tagged = await fetch(server.url + "/http/tagged", { headers: { "x-request-id": requestId } });
        expect(tagged.headers.get("x-request-id")).toBe(requestId);
        expect(await tagged.text()).toBe("tagged");
      }
    });

    test("205 minimal responses are empty and bound handlers receive the original Request", async () => {
      const res = await fetch(server.url + "/http/reset");
      expect([res.status, await res.text()]).toEqual([205, ""]);
      expect(await (await fetch(server.url + "/http/bound")).json()).toBe("/bound");
    });

    if (engine === "archlast") {
      test("a request with a dot segment routes by its normalized path", async () => {
        // The Web fetch client normalizes the path before sending it. This HTTP request preserves it.
        const result = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
          const req = httpRequest(server.url, { path: "/http/./canonical" }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode, body }));
            res.on("error", reject);
          });
          req.on("error", reject);
          req.end();
        });
        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ path: "/canonical", urlPath: "/canonical" });
      });
    }
  });
}

describe("HTTP streaming in a child runtime", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer({ forgeDir: fixture, env: { ...baseEnv, DATA_DIR: tempDir(), HTTP_ENGINE: "bun", RUNTIME_MODE: "process" } });
  });
  afterAll(() => server?.stop({ graceful: false }));

  const progress = async () => (await (await fetch(server.url + "/http/stream-progress")).json()) as { chunks: number; cancelled: boolean };
  const startStream = async () => {
    const response = (await server.runtime.http({ method: "GET", url: server.url + "/paced-stream", headers: [] }, {}, "slow-reader")) as HttpResponseMessage;
    return response.body as ReadableStream<Uint8Array>;
  };
  const waitForPause = async () => {
    for (let i = 0; i < 50 && (await progress()).chunks < 8; i++) await Bun.sleep(10);
    const { chunks } = await progress();
    expect(chunks).toBeGreaterThanOrEqual(8);
    expect(chunks).toBeLessThan(20);
  };

  test("production pauses with an unread response and resumes without losing bytes", async () => {
    const body = await startStream();
    try {
      await waitForPause();

      const actual = await new Response(body).bytes();
      let start = 0;
      for (let i = 1; i <= 20; i++) {
        const end = start + (i === 16 ? 294_912 : 32_768);
        expect(actual[start]).toBe(i);
        expect(actual[end - 1]).toBe(i);
        start = end;
      }
      expect(actual.byteLength).toBe(start);
    } finally {
      if (!body.locked) await body.cancel();
    }
  });
  test("cancelling an unread response wakes the producer waiting for room", async () => {
    const body = await startStream();
    try {
      await waitForPause();
    } finally {
      await body.cancel();
    }
    for (let i = 0; i < 50 && !(await progress()).cancelled; i++) await Bun.sleep(10);
    expect((await progress()).cancelled).toBe(true);
  });
});

describe.skipIf(!canUseNative)("Nest streaming through the native HTTP path", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer({
      forgeDir: join(import.meta.dir, "fixture-helmet"),
      env: { ...baseEnv, DATA_DIR: tempDir(), HTTP_ENGINE: "archlast", RUNTIME_MODE: "process", TRUST_PROXY: "1" },
    });
  });
  afterAll(() => server?.stop({ graceful: false }));

  test("a streamed file stays a stream and receives the API security headers", async () => {
    const routed = server.url + "/api/ping/file";
    const direct = (await server.runtime.http({ method: "GET", url: routed, headers: [] }, {}, "streamed-file")) as HttpResponseMessage;
    expect(direct.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(direct.body as ReadableStream).text()).toBe("one two");

    const res = await fetch(server.url + "/http/api/ping/file");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(await res.text()).toBe("one two");
  });

  test("Nest write returns false and drains when the client reads", async () => {
    const res = await fetch(server.url + "/http/api/ping/drain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("A".repeat(128 * 1024) + "drained");
  });

  test("a trusted proxy supplies the protocol for its connection", async () => {
    const request = (proto: string) => fetch(server.url + "/http/api/ping/protocol", { headers: { "x-forwarded-proto": proto } });
    expect(await (await request("http, https")).json()).toEqual({ protocol: "https", secure: true });
    expect(await (await request("other")).json()).toEqual({ protocol: "http", secure: false });
  });

  test("a controller rejection is sanitized even when the thrown value is undefined", async () => {
    const res = await fetch(server.url + "/http/api/ping/failure", { headers: { "x-request-id": "nest-failure" } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Server error (request nest-failure)");
  });
});
