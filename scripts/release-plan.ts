#!/usr/bin/env bun
// `bun scripts/release-plan.ts [--sha SHA]`: what the release workflow has to do for a commit of master. It publishes nothing.
//
// A merge into master is a release unless it ships nothing (see scripts/release-bump.ts). Its version is chosen here:
//  - packages/*/package.json above the last release (a person ran scripts/version.ts): that version, as it is;
//  - otherwise the next patch after the last release, or the next minor when the change adds to what users see.
// The version is not committed: the workflow stamps it into the packages and the image, and the tag records it.
//
// It prints (and writes to $GITHUB_OUTPUT): release=true|false, version, prerelease, since (the last release's tag), bump, reasons, missing.
// release=false when the commit ships nothing, or was already released (a tag points at it, or a later release contains it).
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compare,
  decideBump,
  latestRelease,
  nextVersion,
  parseDiff,
  parseNameStatus,
  watchedForDiff,
  type Change,
} from "./release-bump";

const ROOT = resolve(import.meta.dir, "..");
const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
};
const out = (key: string, value: string) => {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${key}=${value.replace(/\n/g, " ")}\n`,
    );
};

// Every folder of packages/ is published (their package.json say `private`, which scripts/pack.ts removes from the tarballs).
const packages = readdirSync(join(ROOT, "packages")).map(
  (dir) =>
    JSON.parse(
      readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
    ) as { name: string; version: string },
);
const bases = new Set(packages.map((p) => p.version));
if (bases.size !== 1) {
  console.error(
    `The packages are not at one version: ${packages.map((p) => `${p.name}@${p.version}`).join(", ")}. Run \`bun scripts/version.ts X.Y.Z\`.`,
  );
  process.exit(1);
}
const base = [...bases][0]!;

const flag = process.argv.indexOf("--sha");
const sha = git(
  "rev-parse",
  flag > 0 ? process.argv[flag + 1]! : "HEAD",
).trim();

// The last release: the highest v* tag, which must be part of this history.
const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
const latest = latestRelease(
  tags.filter(
    (t) =>
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", t, sha], {
        cwd: ROOT,
      }).exitCode === 0,
  ),
);

const pointing = git("tag", "--points-at", sha)
  .split("\n")
  .filter((t) => /^v\d+\.\d+\.\d+/.test(t));
if (pointing.length) {
  console.log(
    `${sha.slice(0, 7)} is ${pointing[0]} already: nothing to release.`,
  );
  out("release", "false");
  process.exit(0);
}
if (
  latest &&
  Bun.spawnSync(["git", "merge-base", "--is-ancestor", sha, `v${latest}`], {
    cwd: ROOT,
  }).exitCode === 0
) {
  console.log(
    `${sha.slice(0, 7)} is part of v${latest} already: nothing to release.`,
  );
  out("release", "false");
  process.exit(0);
}

// What changed since that release.
const since = latest
  ? `v${latest}`
  : git("rev-list", "--max-parents=0", sha).trim().split("\n")[0]!;
const files = parseNameStatus(git("diff", "--name-status", `${since}..${sha}`));
const watched = files.map((f) => f.path).filter(watchedForDiff);
const diffs = watched.length
  ? parseDiff(git("diff", "-U0", `${since}..${sha}`, "--", ...watched))
  : {};
const messages = git("log", "--format=%B%x00", `${since}..${sha}`)
  .split("\0")
  .map((m) => m.trim())
  .filter(Boolean);
const change: Change = { files, messages, diffs };
const { bump, reasons } = decideBump(change);

if (bump === "skip") {
  console.log(`Not a release: ${reasons.join("; ")}.`);
  out("release", "false");
  out("reasons", reasons.join("; "));
  process.exit(0);
}
const { version, chosen } = nextVersion(base, latest, bump);
if (latest && compare(version, latest) <= 0)
  throw new Error(
    `The next version ${version} is not above the last release ${latest}`,
  );

/** Whether the registry has this exact version of the package. Anything but 200 and 404 is an error: a release must not guess. */
async function published(name: string): Promise<boolean> {
  const res = await fetch(
    `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`,
    { headers: { accept: "application/json" } },
  );
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`npm answered ${res.status} for ${name}@${version}`);
}
const missing = (
  await Promise.all(
    packages.map(async (p) => ((await published(p.name)) ? undefined : p.name)),
  )
).filter((n): n is string => Boolean(n));

console.log(
  `Release ${version} (${chosen ? `set in package.json, above ${latest ?? "any release"}` : `${bump} after ${latest}`}): ${reasons.join("; ")}. ${missing.length} of ${packages.length} packages are not on npm yet.`,
);
out("release", "true");
out("version", version);
out("prerelease", version.includes("-") ? "true" : "false");
out("since", latest ? `v${latest}` : "");
out("bump", chosen ? "set" : bump);
out("reasons", reasons.join("; "));
out("missing", missing.join(","));
