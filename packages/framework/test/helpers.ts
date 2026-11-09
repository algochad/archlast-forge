import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "@archlast/forge-runtime/server";
import { nativeEngine } from "../../runtime/src/server/engine";
import { buildApp } from "../src/build";
import { createApp } from "../src/server";

export const fixture = join(import.meta.dir, "fixture");

const made: string[] = [];
process.on("exit", () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
export const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "afx-fw-"));
  made.push(dir);
  return dir;
};

/** An engine serving the fixture app, built the way production builds it. */
export async function startFixture(o: { root?: string; dev?: boolean; islands?: boolean; env?: Record<string, string> } = {}): Promise<RunningServer> {
  const root = o.root ?? fixture;
  const dev = o.dev ?? false;
  if (!dev) await buildApp({ root, dev, islands: o.islands });
  return startServer({
    forgeDir: join(root, "forge"),
    dev,
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: tempDir(),
      BETTER_AUTH_SECRET: "s".repeat(32),
      ALLOW_INSECURE_HTTP: "1",
      RATE_LIMIT_PER_MINUTE: "100000",
      LOG_FORMAT: "json",
      ...o.env,
    },
    app: await createApp({ root, dev, islands: o.islands, log: process.env.FORGE_TEST_LOG ? (_, m) => console.error(m) : () => {} }),
  });
}

/** Signs a user up and returns the cookie header that proves it. */
export async function signUp(srv: RunningServer, email: string, name = "Ada"): Promise<string> {
  const res = await fetch(`${srv.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ email, password: "correct horse battery", name }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

export const stateOf = (html: string) => {
  const m = /window\.__FORGE__=(\{.*?\});<\/script>/s.exec(html);
  if (!m) throw new Error("no window.__FORGE__ in the page");
  return JSON.parse(m[1]!) as import("../src/state").PageState;
};

/** Whether the native HTTP engine is built here (it is where there is a Rust toolchain): what keeps pages for the cache tests. */
export const hasNativeEngine = () => nativeEngine().then(Boolean);
