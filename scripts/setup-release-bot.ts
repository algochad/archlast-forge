#!/usr/bin/env bun
// `bun scripts/setup-release-bot.ts`: sets up, once, what the `docs` job of .github/workflows/release.yml needs to push the release notes to the
// protected master and staging branches after a release (docs/releasing.md#the-release-bot). Run it as the repository owner, with `gh` signed in:
//  1. a new SSH key, added to the repository as a deploy key with write access;
//  2. a `release` environment that only runs on master can use, holding the private key as RELEASE_BOT_KEY (the key never touches the disk
//     beyond this script's temporary folder, which it deletes);
//  3. deploy keys as a bypass actor of the "Protect master" and "Protect staging" rulesets, so that key's pushes are let through. The
//     repository has no other deploy key; any added later with write access could push there too.
// Optionally, `--docs-webhook <url> [--docs-token <token>]` stores Coolify's deploy webhook for the docs site (DOCS_DEPLOY_WEBHOOK,
// DOCS_DEPLOY_TOKEN), so the release also redeploys it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "algochad/archlast-forge";
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const run = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "inherit" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 4).join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
};
const api = (method: string, path: string, body?: unknown) =>
  JSON.parse(run(["gh", "api", "-X", method, `repos/${REPO}/${path}`, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body)) || "null");

const dir = mkdtempSync(join(tmpdir(), "release-bot-"));
try {
  const key = join(dir, "key");
  run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "archlast-forge release bot", "-f", key]);
  const title = "Release bot (release.yml docs job)";
  for (const k of api("GET", "keys") as { id: number; title: string }[]) if (k.title === title) api("DELETE", `keys/${k.id}`); // a key from an earlier run
  api("POST", "keys", { title, key: readFileSync(`${key}.pub`, "utf8").trim(), read_only: false });
  console.log("✓ deploy key added (write access)");

  api("PUT", "environments/release", { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  const policies = api("GET", "environments/release/deployment-branch-policies") as { branch_policies: { name: string }[] };
  if (!policies.branch_policies.some((p) => p.name === "master")) api("POST", "environments/release/deployment-branch-policies", { name: "master", type: "branch" });
  run(["gh", "secret", "set", "RELEASE_BOT_KEY", "--env", "release", "--repo", REPO], readFileSync(key, "utf8"));
  console.log("✓ release environment (master only) with RELEASE_BOT_KEY");

  for (const ruleset of api("GET", "rulesets") as { id: number; name: string }[]) {
    if (!["Protect master", "Protect staging"].includes(ruleset.name)) continue;
    const { bypass_actors } = api("GET", `rulesets/${ruleset.id}`) as { bypass_actors: { actor_type: string }[] };
    if (bypass_actors.some((a) => a.actor_type === "DeployKey")) continue;
    api("PUT", `rulesets/${ruleset.id}`, { bypass_actors: [...bypass_actors, { actor_type: "DeployKey", bypass_mode: "always" }] });
    console.log(`✓ ${ruleset.name}: deploy keys may push`);
  }

  const webhook = option("--docs-webhook");
  if (webhook) {
    run(["gh", "secret", "set", "DOCS_DEPLOY_WEBHOOK", "--env", "release", "--repo", REPO], webhook);
    const token = option("--docs-token");
    if (token) run(["gh", "secret", "set", "DOCS_DEPLOY_TOKEN", "--env", "release", "--repo", REPO], token);
    console.log("✓ the docs site's deploy webhook");
  } else console.log("  The docs site is not redeployed by the release: add --docs-webhook <Coolify deploy URL> [--docs-token <API token>] to set it.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
