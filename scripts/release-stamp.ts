#!/usr/bin/env bun
// `bun scripts/release-stamp.ts X.Y.Z [--since vA.B.C] [--released <file>]`: makes the docs say what was released. The release workflow runs it
// after publishing, on master and then on staging, and pushes the result (`docs` in .github/workflows/release.yml), so nobody edits the release
// notes by hand for a release:
//  - apps/docs/content/release-notes.mdx: what is under "## Unreleased" moves under "## X.Y.Z" (unless that heading exists already), and a new
//    empty "## Unreleased" goes above it. `--released` is the page as it was in the released commit: only its "Unreleased" lines move, so
//    notes that reached staging after the release stay under "Unreleased".
//  - The version strings of the docs' samples (the CLI's banner, the engine image tag, a dependency range, the reference's header) go from the
//    version `--since` names to X.Y.Z.
// Prints the files it changed. Running it again changes nothing.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stampNotes, stampVersionStrings } from "./release-notes";

const ROOT = resolve(import.meta.dir, "..");
const CONTENT = join(ROOT, "apps/docs/content");
const REPO = "https://github.com/algochad/archlast-forge";
const args = process.argv.slice(2);
const version = args[0];
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun scripts/release-stamp.ts X.Y.Z [--since vA.B.C] [--released <file>]");
  process.exit(1);
}
const since = option("--since");
const releasedFile = option("--released");
const released = releasedFile ? readFileSync(releasedFile, "utf8") : undefined;
const previous = since?.replace(/^v/, "");

const changed: string[] = [];
const update = (path: string, change: (text: string) => string) => {
  const text = readFileSync(path, "utf8");
  const next = change(text);
  if (next === text) return;
  writeFileSync(path, next);
  changed.push(relative(ROOT, path));
};

update(join(CONTENT, "release-notes.mdx"), (text) =>
  stampNotes(text, version, { released, compare: since ? `${REPO}/compare/${since}...v${version}` : undefined }),
);
if (previous && previous !== version)
  for (const file of readdirSync(CONTENT).filter((f) => f.endsWith(".mdx") && f !== "release-notes.mdx"))
    update(join(CONTENT, file), (text) => stampVersionStrings(text, previous, version));

console.log(changed.length ? changed.join("\n") : `The docs already say ${version}.`);
