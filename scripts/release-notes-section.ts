#!/usr/bin/env bun
// `bun scripts/release-notes-section.ts X.Y.Z [--since vA.B.C] [--sha SHA]`: the notes of a release, as Markdown for its GitHub release.
//  - A "## X.Y.Z" section in apps/docs/content/release-notes.mdx, when a person wrote one (a release they set the version of): up to the next "## ".
//  - Otherwise the "## Unreleased" section, which in the released commit is what the release contains (the workflow moves it under "## X.Y.Z"
//    afterwards, with scripts/release-stamp.ts), and a link to the comparison.
//  - With neither, what changed: the subjects of the commits since the last release (`--since`) up to `--sha`, and the comparison.
// Links to other docs pages (`page.html#id`) point at their source in the repository.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sectionBody, UNRELEASED } from "./release-notes";

const ROOT = resolve(import.meta.dir, "..");
const REPO = "https://github.com/algochad/archlast-forge";
const args = process.argv.slice(2);
const version = args[0];
const option = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!version || version.startsWith("--")) {
  console.error(
    "Usage: bun scripts/release-notes-section.ts X.Y.Z [--since vA.B.C] [--sha SHA]",
  );
  process.exit(1);
}

const lines = readFileSync(
  join(ROOT, "apps/docs/content/release-notes.mdx"),
  "utf8",
).split("\n");
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
const docs = `${REPO}/blob/master/apps/docs/content`;
const links = (text: string) =>
  text.replace(
    /\]\(([\w-]+)\.html(#[^)]*)?\)/g,
    (_, page) => `](${docs}/${page}.mdx)`,
  );

if (start >= 0) {
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  console.log(
    links(
      lines
        .slice(start + 1, end < 0 ? undefined : end)
        .join("\n")
        .trim(),
    ),
  );
  process.exit(0);
}

const since = option("--since");
const compare = since ? `Full comparison: ${REPO}/compare/${since}...v${version}` : undefined;
const unreleased = sectionBody(lines.join("\n"), UNRELEASED);
if (unreleased?.some((l) => l.trim())) {
  console.log(links([...unreleased, ...(compare ? ["", compare] : [])].join("\n")));
  process.exit(0);
}

const sha = option("--sha") ?? "HEAD";
const range = since ? `${since}..${sha}` : sha;
const log = Bun.spawnSync(
  ["git", "log", "--no-merges", "--format=%h %s", range],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
if (log.exitCode !== 0) {
  console.error(`git log ${range}: ${log.stderr.toString().trim()}`);
  process.exit(1);
}
const changes = log.stdout
  .toString()
  .split("\n")
  .filter(Boolean)
  .filter((l) => !/^\w+ Version \d/.test(l));
const shown = changes
  .slice(0, 40)
  .map((l) => `- ${l.replace(/^(\w+) /, "$1 ")}`);
console.log(
  [
    "## What's changed",
    "",
    ...(shown.length
      ? shown
      : ["- Changes to the packages since the last release."]),
    ...(changes.length > shown.length
      ? [`- … and ${changes.length - shown.length} more`]
      : []),
    "",
    ...(compare ? [compare, ""] : []),
    `The story of each version is on the [Release notes](${docs}/release-notes.mdx) page.`,
  ].join("\n"),
);
