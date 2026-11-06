import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { deviceAuthorization, jwt, oauthProvider, organization, twoFactor } from "../src/auth-plugins";
import { apiKey } from "../src/auth-plugins/api-key";
import { passkey } from "../src/auth-plugins/passkey";
import { scim } from "../src/auth-plugins/scim";
import { sso } from "../src/auth-plugins/sso";
import { pluginTables } from "../src/server/auth-tables";
import { loadProject } from "../src/server/project";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

// The Better Auth plugins that come with the engine (@archlast/forge-runtime/auth): used in forge/auth.ts, their tables are the engine's.
const fixture = join(import.meta.dir, "fixture-auth-plugins");

describe("the tables of the plugins an app uses", () => {
  test("come from the plugins themselves, as the document adapter stores them", async () => {
    const { tables } = await loadProject(fixture);
    for (const t of ["organizations", "members", "invitations", "twoFactors", "apikeys", "jwkss", "oauthClients", "oauthResources", "oauthClientResources", "oauthRefreshTokens", "oauthAccessTokens", "oauthConsents", "oauthClientAssertions"])
      expect(Object.keys(tables)).toContain(t);
    expect(tables.notes).toBeDefined(); // the app's own
    expect(tables.members!.indexes).toMatchObject({ by_organizationId: ["organizationId"], by_userId: ["userId"] });
    expect(tables.organizations!.fields.logo).toMatchObject({ kind: "union", optional: true }); // optional: absent, or the null Better Auth writes
    expect(tables.oauthClients!.fields.metadata!.members?.[0]).toMatchObject({ kind: "any" });
    // Better Auth's own models are built in; what a plugin adds to them (a session's active organization) isn't a table.
    expect(Object.keys(tables)).not.toContain("sessionss");
  });

  test("follow the plugins' options, and an app's own declaration of one wins", () => {
    expect(Object.keys(pluginTables({ plugins: [organization({ teams: { enabled: true } })] }))).toEqual(["organizations", "teams", "teamMembers", "members", "invitations"]);
    const mine = pluginTables({ plugins: [organization()] }, ["members"]);
    expect(Object.keys(mine)).not.toContain("members");
    expect(Object.keys(pluginTables({ plugins: [jwt(), oauthProvider({ loginPage: "/a", consentPage: "/b" })] }))).toContain("jwkss");
  });

  test("every plugin that comes with the engine and has tables of its own gets them", () => {
    const tablesOf = (plugin: unknown) => Object.keys(pluginTables({ plugins: [plugin] as never }));
    expect(tablesOf(twoFactor())).toEqual(["twoFactors"]);
    expect(tablesOf(deviceAuthorization())).toEqual(["deviceCodes"]);
    expect(tablesOf(apiKey())).toEqual(["apikeys"]);
    expect(tablesOf(passkey())).toEqual(["passkeys"]);
    expect(tablesOf(sso())).toEqual(["ssoProviders"]);
    expect(tablesOf(scim({ connections: [], managedConnections: { credentialHashSecret: "s".repeat(32) } } as never))).toContain("scimUsers");
  });

  test("an app that uses none gets none", async () => {
    const { tables } = await loadProject(join(import.meta.dir, "fixture"));
    expect(Object.keys(tables).filter((t) => /^(organizations|members|oauth|jwks)/.test(t))).toEqual([]);
  });
});

describe("in a running engine", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({
      forgeDir: fixture,
      env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json" },
    });
  });
  afterAll(() => srv.stop({ graceful: false }));

  const auth = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
    fetch(`${srv.url}/api/auth${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { "content-type": "application/json", origin: srv.url, ...(init.cookie && { cookie: init.cookie }) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

  test("organizations, members and OAuth clients are written to the plugin tables and read back", async () => {
    const signUp = await auth("/sign-up/email", { body: { email: "owner@example.com", password: "correct horse battery", name: "Owner" } });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const created = await auth("/organization/create", { body: { name: "Acme", slug: "acme" }, cookie });
    expect(created.status).toBe(200);
    expect(((await (await auth("/organization/list", { cookie })).json()) as any[]).map((o) => o.slug)).toEqual(["acme"]);
    // The member row the plugin wrote, read by a function through ctx.db.
    const mine = await fetch(`${srv.url}/rpc/tenants:memberships`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" });
    expect(((await mine.json()) as any).result).toEqual([{ role: "owner", organization: "Acme" }]);

    const client = await auth("/oauth2/create-client", { body: { redirect_uris: ["https://partner.example/callback"], client_name: "Partner" }, cookie });
    expect(client.status).toBe(201);
    expect(((await client.json()) as any).client_id).toBeString();
    // An API key, in the apikeys table.
    const key = await auth("/api-key/create", { body: { name: "ci" }, cookie });
    expect(key.status).toBe(200);
    expect(((await key.json()) as any).key).toBeString();
    expect(((await (await auth("/api-key/list", { cookie })).json()) as { apiKeys: { name: string }[] }).apiKeys.map((k) => k.name)).toEqual(["ci"]);
    const keys = (await (await auth("/jwks")).json()) as { keys: unknown[] };
    expect(keys.keys.length).toBeGreaterThan(0); // signing keys, kept in jwkss
  });
});
