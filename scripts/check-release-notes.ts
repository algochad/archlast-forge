#!/usr/bin/env bun
// `bun scripts/check-release-notes.ts [base]`: when the version in packages/runtime/package.json differs from the one at `base` (a pull request
// into master that releases), apps/docs/content/release-notes.mdx must have a "## X.Y.Z" heading for it. CI runs it on pull requests into master.
// Without a version change there is nothing to check.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const base = process.argv[2] ?? "origin/master";
const versionOf = (json: string) => (JSON.parse(json) as { version: string }).version;

const now = versionOf(readFileSync(join(ROOT, "packages/runtime/package.json"), "utf8"));
const git = Bun.spawnSync(["git", "show", `${base}:packages/runtime/package.json`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
if (git.exitCode !== 0) {
  console.error(`Could not read packages/runtime/package.json at ${base}: ${git.stderr.toString().trim()}`);
  process.exit(1);
}
const was = versionOf(git.stdout.toString());

if (now === was) {
  console.log(`The version is ${now}, as on ${base}: no release notes to check.`);
  process.exit(0);
}
const notes = readFileSync(join(ROOT, "apps/docs/content/release-notes.mdx"), "utf8");
if (!new RegExp(`^## ${now.replace(/[.+]/g, "\\$&")}\\s*$`, "m").test(notes)) {
  console.error(`The version goes from ${was} to ${now}, but apps/docs/content/release-notes.mdx has no "## ${now}" heading.\nMove what is under "## Unreleased" under it, in a commit on staging, before the pull request into master.`);
  process.exit(1);
}
console.log(`Release notes for ${now}: found (the version was ${was}).`);
