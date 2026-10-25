import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

let srv: RunningServer;
beforeAll(async () => {
  srv = await startServer({
    forgeDir: join(import.meta.dir, "fixture"),
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", TRUSTED_ORIGINS: "https://app.example.test", LOG_FORMAT: "json" },
  });
});
afterAll(() => srv.stop({ graceful: false }));

/** Whether the handshake succeeded. */
const connects = (origin?: string) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`, origin ? ({ headers: { origin } } as any) : undefined);
    ws.onopen = () => (ws.close(), resolve(true));
    ws.onerror = () => resolve(false);
  });

test("a browser page on another origin can't open a live-query socket; the right ones can", async () => {
  expect(await connects("https://evil.example.test")).toBe(false);
  expect(await connects("http://localhost.evil.test")).toBe(false);
  expect(await connects("null")).toBe(false); // sandboxed pages and redirects
  expect(await connects("https://app.example.test")).toBe(true); // TRUSTED_ORIGINS
  expect(await connects(srv.url)).toBe(true); // its own address
  expect(await connects()).toBe(true); // not a browser: no Origin
});

test("the refusal says what to do", async () => {
  const res = await fetch(`${srv.url}/rpc`, { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: "https://evil.example.test" } });
  expect(res.status).toBe(403);
  expect(await res.text()).toContain("TRUSTED_ORIGINS");
});
