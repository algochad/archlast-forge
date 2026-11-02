#!/usr/bin/env bun
// Refreshes the API explorer: Scalar's standalone browser bundle (MIT), kept brotli-compressed in packages/dashboard/vendor/scalar with its
// license and version, so the engine serves it without installing @scalar/api-reference (56 MB) everywhere the CLI is installed.
// bun scripts/update-scalar.ts [version]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const version = process.argv[2] ?? "1.76.4";
const out = join(import.meta.dir, "../packages/dashboard/vendor/scalar");
const tmp = mkdtempSync(join(tmpdir(), "scalar-"));
try {
  const res = await fetch(`https://registry.npmjs.org/@scalar/api-reference/-/api-reference-${version}.tgz`);
  if (!res.ok) throw new Error(`npm answered ${res.status} for @scalar/api-reference@${version}`);
  writeFileSync(join(tmp, "p.tgz"), new Uint8Array(await res.arrayBuffer()));
  const tar = Bun.spawnSync(["tar", "-xzf", "p.tgz", "package/dist/browser/standalone.js", "package/package.json"], { cwd: tmp });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const js = await Bun.file(join(tmp, "package/dist/browser/standalone.js")).bytes();
  mkdirSync(out, { recursive: true });
  const br = brotliCompressSync(js, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(join(out, "standalone.js.br"), br);
  // The package declares MIT but ships no license file: the text is the repository's.
  const pkg = await Bun.file(join(tmp, "package/package.json")).json();
  if (pkg.license !== "MIT") throw new Error(`@scalar/api-reference ${version} is licensed ${pkg.license}, not MIT: check before vendoring it`);
  const license = await fetch("https://raw.githubusercontent.com/scalar/scalar/main/LICENSE");
  if (!license.ok) throw new Error(`GitHub answered ${license.status} for Scalar's LICENSE`);
  writeFileSync(join(out, "LICENSE"), `@scalar/api-reference ${version} (${pkg.repository?.url ?? "https://github.com/scalar/scalar"}), standalone browser bundle, MIT:\n\n${await license.text()}`);
  writeFileSync(join(out, "VERSION"), `${version}\n`);
  console.log(`@scalar/api-reference ${version}: ${js.length} bytes, ${Bun.gzipSync(js).length} gzip, ${br.length} brotli -> ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
