import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

let srv: RunningServer;
beforeAll(async () => {
  srv = await startServer({
    forgeDir: join(import.meta.dir, "fixture"),
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "3", TRUST_PROXY: "1", LOG_FORMAT: "json" },
  });
});
afterAll(() => srv.stop({ graceful: false }));

const call = (forwardedFor: string) => fetch(`${srv.url}/rpc/todos:events?args=%7B%7D`, { headers: { "x-forwarded-for": forwardedFor } }).then((r) => r.status);

test("behind a trusted proxy the address that counts is the one the proxy appended, not one the client made up", async () => {
  // The same real client (last entry) each time, pretending to be somebody new in front of it.
  expect(await call("1.1.1.1, 9.9.9.9")).toBe(200);
  expect(await call("2.2.2.2, 9.9.9.9")).toBe(200);
  expect(await call("3.3.3.3, 9.9.9.9")).toBe(200);
  expect(await call("4.4.4.4, 9.9.9.9")).toBe(429); // still 9.9.9.9
  // Another real client has its own allowance, whatever it claims to be.
  expect(await call("1.1.1.1, 8.8.8.8")).toBe(200);
  // One entry (a proxy that replaces the header) works as it did.
  expect(await call("7.7.7.7")).toBe(200);
});
