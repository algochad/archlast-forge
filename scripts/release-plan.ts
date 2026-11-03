#!/usr/bin/env bun
// `bun scripts/release-plan.ts [--version X.Y.Z]`: what the release workflow has to do for this commit. It publishes nothing.
//  - reads the version of the nine packages (they move in lockstep: a package that differs is an error),
//  - asks the npm registry which of them already has that version,
//  - needs the docs' release notes to have a "## X.Y.Z" heading, since the GitHub release is written from it,
//  - and prints `release=true|false`, `version`, `prerelease` and `missing` (to $GITHUB_OUTPUT when it is set).
// release=false when every package already has the version: a merge into master that isn't a release, or a release that is finished.
// `--version` plans for another version, to try the registry check without touching the packages.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
// Every folder of packages/ is published (their package.json say `private`, which scripts/pack.ts removes from the tarballs).
const packages = readdirSync(join(ROOT, "packages")).map(
  (dir) =>
    JSON.parse(
      readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
    ) as { name: string; version: string },
);

const versions = new Set(packages.map((p) => p.version));
if (versions.size !== 1) {
  console.error(
    `The packages are not at one version: ${packages.map((p) => `${p.name}@${p.version}`).join(", ")}. Run \`bun scripts/version.ts X.Y.Z\`.`,
  );
  process.exit(1);
}
const flag = process.argv.indexOf("--version");
const version = flag > 0 ? process.argv[flag + 1]! : [...versions][0]!;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`"${version}" is not a version like 1.2.3 or 1.2.3-rc.1`);
  process.exit(1);
}

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

const out = (key: string, value: string) => {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

if (!missing.length) {
  console.log(
    `All ${packages.length} packages already have ${version} on npm: nothing to release.`,
  );
  out("release", "false");
  out("version", version);
  process.exit(0);
}

const notes = readFileSync(
  join(ROOT, "apps/docs/content/release-notes.mdx"),
  "utf8",
);
if (
  !new RegExp(`^## ${version.replace(/[.+]/g, "\\$&")}\\s*$`, "m").test(notes)
) {
  console.error(
    `${version} is not on npm, but apps/docs/content/release-notes.mdx has no "## ${version}" heading, so there are no release notes to publish with it. Nothing was published.`,
  );
  process.exit(1);
}
console.log(
  `Release ${version}: ${missing.length} of ${packages.length} packages are not on npm yet (${missing.join(", ")}).`,
);
out("release", "true");
out("version", version);
out("prerelease", version.includes("-") ? "true" : "false");
out("missing", missing.join(","));
