// Better Auth's OAuth Provider metadata at the addresses clients look for it: the issuer's own (/api/auth/.well-known/…) and the root
// ones RFC 8414 and OpenID Connect derive from an issuer with a path (/.well-known/…/api/auth), which the engine routes to Better Auth.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

let srv: RunningServer;
beforeAll(async () => {
  srv = await startServer({
    forgeDir: join(import.meta.dir, "fixture-oauth"),
    env: { ...process.env, RUNTIME_MODE: "process", PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "0" },
  });
}, 30_000);
afterAll(() => srv?.stop({ graceful: false }));

test("the authorization-server metadata answers at the issuer's address and at the root form RFC 8414 derives", async () => {
  const issued = await (await fetch(`${srv.url}/api/auth/.well-known/oauth-authorization-server`)).json();
  const root = await fetch(`${srv.url}/.well-known/oauth-authorization-server/api/auth`);
  expect(root.status).toBe(200);
  expect(await root.json()).toEqual(issued);
  expect(issued.issuer).toBe(`${srv.url}/api/auth`);
  expect(issued.token_endpoint).toBe(`${srv.url}/api/auth/oauth2/token`);
});

test("so does the OpenID configuration", async () => {
  const issued = await (await fetch(`${srv.url}/api/auth/.well-known/openid-configuration`)).json();
  const root = await fetch(`${srv.url}/.well-known/openid-configuration/api/auth`);
  expect(root.status).toBe(200);
  expect(await root.json()).toEqual(issued);
  expect(issued.jwks_uri).toBe(`${srv.url}/api/auth/jwks`);
});

test("only GET reaches it, and only those two names", async () => {
  expect((await fetch(`${srv.url}/.well-known/oauth-authorization-server/api/auth`, { method: "POST" })).status).toBe(404);
  expect((await fetch(`${srv.url}/.well-known/security.txt/api/auth`)).status).toBe(404);
  expect((await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).status).toBe(404); // the bare root is for an issuer without a path
});
