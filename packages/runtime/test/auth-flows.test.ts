import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

let srv: RunningServer;
beforeAll(async () => {
  srv = await startServer({
    forgeDir: join(import.meta.dir, "fixture-auth"),
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json", ADMIN_KEY: "root-key-for-tests", DASHBOARD: "on" },
  });
});
afterAll(() => srv.stop({ graceful: false }));

const post = (path: string, body: unknown) =>
  fetch(`${srv.url}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: srv.url }, body: JSON.stringify(body) });

test("a forgotten password can be reset, and only the new one works", async () => {
  expect((await post("/sign-up/email", { email: "ada@example.com", password: "old password 123", name: "Ada" })).status).toBe(200);

  const asked = await post("/request-password-reset", { email: "ada@example.com", redirectTo: "/reset" });
  expect(asked.status).toBe(200);
  const mail = ((globalThis as any).__resetMail as { to: string; token: string }[]).at(-1)!;
  expect(mail.to).toBe("ada@example.com");

  const reset = await post("/reset-password", { newPassword: "new password 456", token: mail.token });
  expect(await reset.text()).not.toContain("atomic fallbacks");
  expect(reset.status).toBe(200);

  expect((await post("/sign-in/email", { email: "ada@example.com", password: "old password 123" })).status).toBe(401);
  expect((await post("/sign-in/email", { email: "ada@example.com", password: "new password 456" })).status).toBe(200);
  // The link works once.
  expect((await post("/reset-password", { newPassword: "third password 789", token: mail.token })).status).toBe(400);
});

const admin = async (op: string, input: unknown, write = false) => {
  const res = write
    ? await fetch(`${srv.url}/_admin/${op}`, { method: "POST", headers: { "x-admin-key": "root-key-for-tests", "x-forge-admin": "1", "content-type": "application/json" }, body: JSON.stringify(input) })
    : await fetch(`${srv.url}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "x-admin-key": "root-key-for-tests" } });
  return (await res.json()) as any;
};

test("the dashboard never shows credentials, and saving a redacted document doesn't erase them", async () => {
  await post("/sign-up/email", { email: "grace@example.com", password: "grace password 1", name: "Grace" });

  const accounts = await admin("docs", { table: "accounts" });
  const account = accounts.page.find((a: any) => a.accountId);
  expect(account.password).toBe("[hidden]");
  expect(account.providerId).toBe("credential"); // everything else is as it was
  expect(JSON.stringify(await admin("docs", { table: "sessions" }))).not.toMatch(/"token":"(?!\[hidden\])/);
  const byId = await admin("docsByIds", { ids: [account._id] });
  expect(byId[account._id].password).toBe("[hidden]");

  // An editor that saves the document it was shown sends the placeholder back.
  await admin("replaceDoc", { id: account._id, value: { ...account, updatedAt: 12345 } }, true);
  expect((await post("/sign-in/email", { email: "grace@example.com", password: "grace password 1" })).status).toBe(200);
  await admin("patchDoc", { id: account._id, value: { password: "[hidden]", providerId: "credential" } }, true);
  const after = (await admin("docs", { table: "accounts" })).page.find((a: any) => a._id === account._id);
  expect(after.updatedAt).toBe(12345);
  expect((await post("/sign-in/email", { email: "grace@example.com", password: "grace password 1" })).status).toBe(200);
});

test("Better Auth's sign-in limit can't be dodged with a made-up X-Forwarded-For", async () => {
  const limited = await startServer({
    forgeDir: join(import.meta.dir, "fixture-auth-limited"),
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json" },
  });
  try {
    const attempt = (xff: string) =>
      fetch(`${limited.url}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: limited.url, "x-forwarded-for": xff, "x-archlast-client-ip": xff }, body: JSON.stringify({ email: "nobody@example.com", password: "wrong password" }) }).then((r) => r.status);
    const statuses = [];
    for (const xff of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"]) statuses.push(await attempt(xff)); // one real client, five claimed identities
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses.slice(3)).toEqual([429, 429]);
  } finally {
    await limited.stop({ graceful: false });
  }
});
