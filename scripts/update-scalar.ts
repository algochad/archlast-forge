#!/usr/bin/env bun
// Builds the API explorer ("Try it") from the engine's fork of Scalar and vendors the result. packages/dashboard/scalar/README.md has the
// whole story; the short version:
//
//   packages/dashboard/scalar/UPSTREAM   the pinned upstream release (repository, tag, commit)
//   packages/dashboard/scalar/patches/   the engine's changes to upstream's source, applied in order with `git apply`
//   packages/dashboard/scalar/entry.ts   window.ForgeExplorer, on top of Scalar's API client modal (ours, not a patch)
//
// bun scripts/update-scalar.ts            build, and write packages/dashboard/vendor/scalar/{explorer.js.br, explorer.css.br, VERSION, LICENSE}
//                                         and packages/dashboard/THIRD_PARTY_NOTICES.md
// bun scripts/update-scalar.ts --check    build, and fail if what is vendored differs from the build (writes nothing)
// bun scripts/update-scalar.ts --clean    also delete the cache first (a fresh clone, install and build of upstream)
//
// The upstream checkout and its node_modules live in ~/.cache/archlast-forge/scalar (FORGE_SCALAR_CACHE to move it; keep it out of any
// folder with a node_modules/.bin above it), never in the repository. A first run clones, installs and builds upstream's dependencies (a few minutes, needs Node 22+ and network);
// later runs only bundle the entry (seconds) unless UPSTREAM or a patch changed.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const fork = join(root, "packages/dashboard/scalar");
const vendor = join(root, "packages/dashboard/vendor/scalar");
const noticesFile = join(root, "packages/dashboard/THIRD_PARTY_NOTICES.md");
// Not inside this repository: pnpm puts every ancestor's node_modules/.bin on PATH, so a checkout below this repository's node_modules would
// build with this repository's TypeScript instead of upstream's.
const cache = process.env.FORGE_SCALAR_CACHE ? resolve(process.env.FORGE_SCALAR_CACHE) : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "archlast-forge", "scalar");
const checkout = join(cache, "src");

const args = new Set(process.argv.slice(2));
if (args.has("--help") || [...args].some((a) => !["--check", "--clean", "--help"].includes(a))) {
  console.log("usage: bun scripts/update-scalar.ts [--check] [--clean]   (see the header of this file)");
  process.exit(args.has("--help") ? 0 : 2);
}
const check = args.has("--check");

const started = Date.now();
const step = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);

/** Runs a command, keeps its output in the cache's build.log, and shows the tail of it when the command fails. */
async function run(argv: string[], cwd: string, env: Record<string, string> = {}, quiet = false): Promise<string> {
  // `bun script.ts` puts this repository's node_modules/.bin (its own TypeScript, ...) first on PATH: upstream's build must find its own.
  const path = [join(checkout, "node_modules/.bin"), ...(process.env.PATH ?? "").split(":").filter((dir) => dir && !/node_modules[\\/]\.bin$/.test(dir))].join(":");
  const proc = Bun.spawn(argv, { cwd, env: { ...process.env, PATH: path, CI: "1", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  mkdirSync(cache, { recursive: true });
  const log = `$ ${argv.join(" ")}\n${out}${err}\n`;
  writeFileSync(join(cache, "build.log"), log, { flag: "a" });
  if (code !== 0) {
    if (!quiet) console.error(log.split("\n").slice(-60).join("\n"));
    throw new Error(`\`${argv.join(" ")}\` failed (exit ${code}); the full output is in ${join(cache, "build.log")}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Upstream: the pinned checkout with the patches applied

interface Upstream {
  repo: string;
  tag: string;
  commit: string;
}

function readUpstream(): Upstream {
  const entries = Object.fromEntries(
    readFileSync(join(fork, "UPSTREAM"), "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
  );
  for (const key of ["repo", "tag", "commit"]) if (!entries[key]) throw new Error(`packages/dashboard/scalar/UPSTREAM has no ${key}=`);
  if (!/^[0-9a-f]{40}$/.test(entries.commit!)) throw new Error("UPSTREAM: commit must be a full 40-character SHA");
  return entries as unknown as Upstream;
}

const git = (cwd: string, ...argv: string[]) => run(["git", ...argv], cwd);
const gitQuietly = (cwd: string, ...argv: string[]) => run(["git", ...argv], cwd, {}, true);

/** The pinned commit, checked out clean (build outputs and node_modules are ignored files and stay, which is what makes later runs fast). */
async function prepareCheckout(up: Upstream) {
  mkdirSync(checkout, { recursive: true });
  if (!existsSync(join(checkout, ".git"))) {
    await git(checkout, "init", "--quiet");
    await git(checkout, "remote", "add", "origin", up.repo);
  } else await git(checkout, "remote", "set-url", "origin", up.repo);
  const haveCommit = await gitQuietly(checkout, "cat-file", "-t", up.commit).then(
    (t) => t.trim() === "commit",
    () => false,
  );
  if (!haveCommit) {
    step(`fetching ${up.tag} from ${up.repo}`);
    await git(checkout, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", `+refs/tags/${up.tag}:refs/tags/${up.tag}`);
    const tagged = (await git(checkout, "rev-parse", `${up.tag}^{commit}`)).trim();
    if (tagged !== up.commit) throw new Error(`${up.tag} is ${tagged} upstream now, but UPSTREAM pins ${up.commit}: a moved tag is not something to build from silently`);
  }
  await git(checkout, "checkout", "--quiet", "--force", "--detach", up.commit);
  await git(checkout, "reset", "--quiet", "--hard");
  await git(checkout, "clean", "-fdq");
}

function listPatches(): string[] {
  const dir = join(fork, "patches");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".patch"))
        .sort()
    : [];
}

async function applyPatches(patches: string[]) {
  for (const name of patches) {
    const file = join(fork, "patches", name);
    try {
      await gitQuietly(checkout, "apply", "--check", "--whitespace=nowarn", file);
      await git(checkout, "apply", "--whitespace=nowarn", file);
    } catch (error) {
      throw new Error(`patches/${name} does not apply to the pinned upstream. Rebase the patch series onto it (packages/dashboard/scalar/README.md, "Updating upstream"):\n${(error as Error).message}`);
    }
  }
}

/** pnpm of the version upstream asks for (`packageManager`): the one on PATH when it is that version, else through npx or bunx. */
async function pnpmCommand(): Promise<string[]> {
  const wanted = /^pnpm@([^+]+)/.exec(JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).packageManager ?? "")?.[1];
  if (!wanted) throw new Error("upstream's package.json has no packageManager: pnpm@<version>");
  if (!Bun.which("node")) throw new Error("Node.js (22 or newer) must be on PATH: Scalar's build tools run on it");
  const local = Bun.which("pnpm");
  if (local && (await run([local, "--version"], checkout)).trim() === wanted) return [local];
  const npx = Bun.which("npx");
  if (npx) return [npx, "--yes", `pnpm@${wanted}`];
  const bunx = Bun.which("bunx");
  if (bunx) return [bunx, `pnpm@${wanted}`];
  throw new Error(`needs pnpm ${wanted}: install it, or have npx on PATH`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Build

interface Built {
  js: Uint8Array;
  css: Uint8Array;
  licenses: PackageLicense[];
  version: string;
}

async function build(up: Upstream, patches: string[]): Promise<Built> {
  const pnpm = await pnpmCommand();
  const version = `scalar ${up.tag} + ${patches.length} patch${patches.length === 1 ? "" : "es"}`;

  // Upstream's dependencies are installed and built from the patched source, once per (commit, patches, pnpm).
  const stampFile = join(cache, "deps.stamp");
  const stamp = createHash("sha256")
    .update([up.commit, pnpm.join(" "), ...patches.map((p) => readFileSync(join(fork, "patches", p), "utf8"))].join("\0"))
    .digest("hex");
  if (!existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    rmSync(stampFile, { force: true });
    step("installing upstream's dependencies (pnpm install --frozen-lockfile)");
    await run([...pnpm, "install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@scalar/api-client..."], checkout);
    step("building the workspace packages the API client uses (pnpm build; a minute or two)");
    await run([...pnpm, "--filter", "@scalar/api-client^...", "build"], checkout);
    writeFileSync(stampFile, stamp);
  } else step("upstream's dependencies are built already (same upstream and patches)");

  // Our files go into a folder of the API client package, which has every build dependency; relative paths are kept (entry.ts imports
  // the contract's types from ../src/api-docs/contract).
  const overlay = join(checkout, "packages/api-client/forge-explorer");
  rmSync(overlay, { recursive: true, force: true });
  mkdirSync(join(overlay, "scalar"), { recursive: true });
  mkdirSync(join(overlay, "src/api-docs"), { recursive: true });
  cpSync(join(fork, "entry.ts"), join(overlay, "scalar/entry.ts"));
  cpSync(join(fork, "vite.config.ts"), join(overlay, "scalar/vite.config.ts"));
  cpSync(join(root, "packages/dashboard/src/api-docs/contract.ts"), join(overlay, "src/api-docs/contract.ts"));

  step("bundling entry.ts with Scalar's API client (vite build)");
  await run([...pnpm, "--filter", "@scalar/api-client", "exec", "vite", "build", "-c", "forge-explorer/scalar/vite.config.ts"], checkout, { FORGE_EXPLORER_VERSION: version });

  const dist = join(overlay, "dist");
  const emitted = readdirSync(dist).sort();
  const allowed = ["explorer.css", "explorer.js", "licenses.json"];
  if (emitted.join() !== allowed.join()) throw new Error(`the build must emit exactly ${allowed.join(", ")} (one script, one stylesheet), but dist has: ${emitted.join(", ")}`);
  return {
    js: new Uint8Array(readFileSync(join(dist, "explorer.js"))),
    css: new Uint8Array(readFileSync(join(dist, "explorer.css"))),
    licenses: JSON.parse(readFileSync(join(dist, "licenses.json"), "utf8")),
    version,
  };
}

/** What may not be in the bundle: Scalar's hosted services (telemetry, fonts, proxy, registry, API), and web fonts or images fetched at run time. */
function guardHostedFeatures(built: Built) {
  const js = new TextDecoder().decode(built.js);
  const css = new TextDecoder().decode(built.css);
  const hosts = ["posthog", "fonts.scalar.com", "api.scalar.com", "registry.scalar.com", "void.scalar.com", "proxy.scalar.com", "galaxy.scalar.com", "fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "unpkg.com"];
  const found = hosts.filter((host) => js.includes(host) || css.includes(host));
  if (found.length) throw new Error(`the bundle mentions Scalar's hosted services or a CDN (${found.join(", ")}): switch the feature off by configuration or add a patch`);
  const remote = [...css.matchAll(/url\(\s*["']?(https?:)?\/\/[^)]*\)|@import\s+(url\()?["']?https?:/g)].map((m) => m[0]);
  if (remote.length) throw new Error(`explorer.css loads something from the network (${remote[0]})`);
  const links = [...new Set([...js.matchAll(/https?:\/\/[a-z0-9.-]*scalar\.com/g)].map((m) => new URL(m[0]).host))].sort();
  step(`hosted-features guard passed. Links to Scalar left in the bundle, not requested by it (shown only in parts the engine doesn't render): ${links.join(", ") || "none"}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Licences

interface PackageLicense {
  name: string;
  version: string;
  license: unknown;
  repository?: unknown;
  author?: unknown;
  workspace: boolean;
  bytes: number;
  files: { file: string; text: string }[];
}

const ALLOWED = new Set(["MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Zlib"]);

/** The SPDX id or expression of a package.json `license` / legacy `licenses` field. */
function spdx(license: unknown): string {
  if (typeof license === "string") return license;
  if (Array.isArray(license)) return `(${license.map(spdx).join(" OR ")})`;
  if (license && typeof license === "object" && "type" in license) return String((license as { type: unknown }).type);
  return "UNKNOWN";
}

/** An expression is acceptable when one side of every OR is (a licence we may keep alongside MIT/ISC/BSD/Apache-2.0 code). */
function acceptable(expression: string): boolean {
  const flat = expression.replace(/[()]/g, " ").trim();
  return flat.split(/\s+AND\s+/).every((part) => part.split(/\s+OR\s+/).some((id) => ALLOWED.has(id.trim())));
}

function checkLicenses(licenses: PackageLicense[]) {
  const bad = licenses.filter((p) => !acceptable(spdx(p.license)));
  if (bad.length) throw new Error(`bundled packages with a licence the engine can't ship (allowed: ${[...ALLOWED].join(", ")}):\n${bad.map((p) => `  ${p.name}@${p.version}: ${spdx(p.license)}`).join("\n")}`);
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const ISC_TEXT = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

const holder = (p: PackageLicense): string => {
  const author = p.author;
  const name = typeof author === "string" ? author.replace(/\s*[<(].*$/, "") : author && typeof author === "object" && "name" in author ? String((author as { name: unknown }).name) : "";
  return name.trim() || `the ${p.name} authors`;
};

/** The licence text that ships with a package, or (when the package has no licence file) what package.json says, in the standard words. */
function noticeText(p: PackageLicense, scalarLicense: string): string {
  const files = p.files.map((f) => f.text.trim()).filter(Boolean);
  if (files.length) return files.join("\n\n");
  if (p.workspace && p.name.startsWith("@scalar/")) return scalarLicense.trim();
  const id = spdx(p.license);
  if (id === "MIT") return `MIT License\n\nCopyright (c) ${holder(p)}\n\n${MIT_TEXT}`;
  if (id === "ISC") return `ISC License\n\nCopyright (c) ${holder(p)}\n\n${ISC_TEXT}`;
  throw new Error(`${p.name}@${p.version} (${id}) ships no licence file and the engine has no standard text for ${id}: add the licence text to scripts/update-scalar.ts`);
}

function notices(up: Upstream, built: Built, scalarLicense: string): string {
  const licenses = [...built.licenses].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const groups = new Map<string, { text: string; users: string[] }>();
  for (const p of licenses) {
    const text = noticeText(p, scalarLicense);
    const key = text.replace(/\s+/g, " ");
    const group = groups.get(key) ?? { text, users: [] };
    group.users.push(`${p.name}@${p.version}`);
    groups.set(key, group);
  }
  const counts = new Map<string, number>();
  for (const p of licenses) counts.set(spdx(p.license), (counts.get(spdx(p.license)) ?? 0) + 1);
  const summary = [...counts].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} (${n})`).join(", ");
  const out = [
    "# Third-party notices",
    "",
    `The API explorer (\`vendor/scalar/explorer.js\` and \`explorer.css\`) is built from a fork of [Scalar](${up.repo}) (MIT), pinned to \`${up.tag}\` with the engine's patches on top (\`scalar/README.md\`), and bundles the ${licenses.length} packages below. Their licences are all permissive: ${summary}.`,
    "",
    "This file is written by `bun scripts/update-scalar.ts` from what ended up in the bundle. Do not edit it by hand.",
    "",
    "## Packages",
    "",
    ...licenses.map((p) => `- ${p.name} ${p.version}: ${spdx(p.license)}`),
    "",
    "## Licence texts",
    "",
    "A package without a licence file in its published files has the standard text of its declared licence, with the holder from its package.json.",
    "",
  ];
  let n = 0;
  for (const { text, users } of groups.values()) {
    out.push(`### ${++n}. ${users.join(", ")}`, "", "```text", text, "```", "");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Outputs

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const brotli = (data: Uint8Array) => brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });

/** What gets written, by path (relative to the repository); a `Uint8Array` that is brotli data is compared by what it holds. */
function outputs(up: Upstream, patches: string[], built: Built, scalarLicense: string): Map<string, Uint8Array | string> {
  const files = new Map<string, Uint8Array | string>();
  const rel = (p: string) => p.slice(root.length + 1);
  files.set(rel(join(vendor, "explorer.js.br")), brotli(built.js));
  files.set(rel(join(vendor, "explorer.css.br")), brotli(built.css));
  files.set(
    rel(join(vendor, "VERSION")),
    [
      built.version,
      `upstream: ${up.repo}`,
      `commit: ${up.commit}`,
      "patches:",
      ...patches.map((p) => `  ${p}`),
      `explorer.js: ${built.js.length} bytes, sha256 ${sha(built.js)}`,
      `explorer.css: ${built.css.length} bytes, sha256 ${sha(built.css)}`,
      "",
    ].join("\n"),
  );
  files.set(
    rel(join(vendor, "LICENSE")),
    `Scalar (${up.repo}), ${up.tag}, MIT. The API explorer in this folder is built from a fork of it (packages/dashboard/scalar). The other packages the\nbuild contains, with their licences, are in packages/dashboard/THIRD_PARTY_NOTICES.md.\n\n${scalarLicense.trim()}\n`,
  );
  files.set(rel(noticesFile), notices(up, built, scalarLicense));
  return files;
}

const isBrotli = (path: string) => path.endsWith(".br");

function differences(files: Map<string, Uint8Array | string>): string[] {
  const out: string[] = [];
  for (const [path, want] of files) {
    const file = join(root, path);
    if (!existsSync(file)) {
      out.push(`${path} is missing`);
      continue;
    }
    const have = new Uint8Array(readFileSync(file));
    const same = isBrotli(path)
      ? Buffer.compare(brotliDecompressSync(have), brotliDecompressSync(want as Uint8Array)) === 0
      : Buffer.compare(have, typeof want === "string" ? Buffer.from(want) : want) === 0;
    if (!same) out.push(`${path} differs from the build`);
  }
  return out;
}

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

async function main() {
  if (args.has("--clean")) rmSync(cache, { recursive: true, force: true });
  rmSync(join(cache, "build.log"), { force: true });
  const up = readUpstream();
  const patches = listPatches();
  step(`upstream ${up.tag} (${up.commit.slice(0, 7)}), ${patches.length} patch${patches.length === 1 ? "" : "es"}`);
  await prepareCheckout(up);
  await applyPatches(patches);
  const built = await build(up, patches);
  checkLicenses(built.licenses);
  guardHostedFeatures(built);
  const scalarLicense = readFileSync(join(checkout, "LICENSE"), "utf8");
  const files = outputs(up, patches, built, scalarLicense);

  const br = files.get("packages/dashboard/vendor/scalar/explorer.js.br") as Uint8Array;
  const brCss = files.get("packages/dashboard/vendor/scalar/explorer.css.br") as Uint8Array;
  console.log(`explorer.js   ${built.js.length} bytes, ${gzipSync(built.js, { level: 9 }).length} gzip, ${br.length} brotli`);
  console.log(`explorer.css  ${built.css.length} bytes, ${gzipSync(built.css, { level: 9 }).length} gzip, ${brCss.length} brotli`);
  console.log(`${built.licenses.length} bundled packages, all ${[...new Set(built.licenses.map((p) => spdx(p.license)))].sort().join(" / ")}`);

  if (check) {
    const diff = differences(files);
    if (diff.length) {
      console.error(`${diff.join("\n")}\nrun \`bun scripts/update-scalar.ts\` and commit the result`);
      process.exit(1);
    }
    console.log(`vendored explorer matches ${built.version} (${kb(br.length + brCss.length)} brotli)`);
    return;
  }
  mkdirSync(vendor, { recursive: true });
  for (const [path, data] of files) writeFileSync(join(root, path), data);
  rmSync(join(vendor, "standalone.js.br"), { force: true }); // the page no longer loads the full standalone reference
  console.log(`${built.version} -> ${vendor}`);
}

await main();
