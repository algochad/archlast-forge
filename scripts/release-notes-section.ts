#!/usr/bin/env bun
// `bun scripts/release-notes-section.ts X.Y.Z`: the release's notes from apps/docs/content/release-notes.mdx, as Markdown for the GitHub release:
// what is under "## X.Y.Z", up to the next "## ". Links to other docs pages (`page.html#id`) point at their source in the repository.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const version = process.argv[2];
if (!version) {
  console.error("Usage: bun scripts/release-notes-section.ts X.Y.Z");
  process.exit(1);
}
const lines = readFileSync(
  join(ROOT, "apps/docs/content/release-notes.mdx"),
  "utf8",
).split("\n");
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) {
  console.error(`No "## ${version}" in apps/docs/content/release-notes.mdx`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
const body = lines
  .slice(start + 1, end < 0 ? undefined : end)
  .join("\n")
  .trim();
const repo =
  "https://github.com/algochad/archlast-forge/blob/master/apps/docs/content";
console.log(
  body.replace(
    /\]\(([\w-]+)\.html(#[^)]*)?\)/g,
    (_, page) => `](${repo}/${page}.mdx)`,
  ),
);
