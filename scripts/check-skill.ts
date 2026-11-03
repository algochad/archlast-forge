#!/usr/bin/env bun
// Checks the agent skills in skills/ (the `npx skills add` format): `bun run skill:check`.
//  - SKILL.md has front matter with a `name` (equal to its folder, lowercase and hyphens) and a `description`.
//  - Every relative Markdown link resolves, and every file in references/ is linked from SKILL.md.
//  - Every `import { a, b } from "@archlast/..."` in a code block names a package and subpath that exist, and a value that module exports.
//    That is the check that keeps the skill true when the API changes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SKILLS = join(ROOT, "skills");
const errors: string[] = [];
const fail = (where: string, msg: string) =>
  errors.push(`${relative(ROOT, where)}: ${msg}`);

/** Every workspace package's name and its exports, as files. */
const exportsOf = new Map<string, Record<string, string>>();
for (const dir of readdirSync(join(ROOT, "packages"))) {
  const file = join(ROOT, "packages", dir, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8")) as {
    name: string;
    exports?: Record<string, string | Record<string, string>>;
  };
  const map: Record<string, string> = {};
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    const path =
      typeof target === "string"
        ? target
        : (target.import ?? target.default ?? target.types);
    if (path) map[key] = join(ROOT, "packages", dir, path);
  }
  exportsOf.set(pkg.name, map);
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) =>
    statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)],
  );

if (!existsSync(SKILLS)) {
  console.error("No skills/ folder.");
  process.exit(1);
}

const moduleCache = new Map<string, Promise<Record<string, unknown>>>();
const load = (file: string) =>
  moduleCache.get(file) ?? moduleCache.set(file, import(file)).get(file)!;

for (const name of readdirSync(SKILLS)) {
  const root = join(SKILLS, name);
  if (!statSync(root).isDirectory()) continue;
  const skillFile = join(root, "SKILL.md");
  if (!existsSync(skillFile)) {
    fail(root, "no SKILL.md");
    continue;
  }

  const text = readFileSync(skillFile, "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (!front) fail(skillFile, "no front matter");
  else {
    const field = (key: string) =>
      new RegExp(`^${key}:\\s*(.+)$`, "m")
        .exec(front)?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "");
    const skillName = field("name");
    const description = field("description");
    if (skillName !== name)
      fail(skillFile, `name "${skillName}" must equal its folder "${name}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName ?? ""))
      fail(skillFile, "name must be lowercase letters, digits and hyphens");
    if (!description) fail(skillFile, "no description");
    else if (description.length > 1024)
      fail(
        skillFile,
        `description is ${description.length} characters; keep it under 1024`,
      );
  }
  if (text.split("\n").length > 500)
    fail(skillFile, "SKILL.md is over 500 lines: move detail into references/");

  const files = walk(root).filter((f) => f.endsWith(".md"));
  const linked = new Set<string>();
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    // Links
    for (const [, target] of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target!)) continue;
      const path = resolve(dirname(file), target!.split("#")[0]!);
      if (!existsSync(path)) fail(file, `broken link ${target}`);
      else if (file === skillFile) linked.add(path);
    }
    // Imports in code blocks
    for (const [, block] of body.matchAll(/```(?:ts|tsx)\n([\s\S]*?)```/g)) {
      for (const [, clause, spec] of block!.matchAll(
        /import\s+([^;]*?)\s+from\s+"([^"]+)"/g,
      )) {
        const pkg = spec!.startsWith("@")
          ? spec!.split("/").slice(0, 2).join("/")
          : spec!.split("/")[0]!;
        if (!pkg.startsWith("@archlast/") && pkg !== "create-archlast-forge")
          continue;
        const exports = exportsOf.get(pkg);
        const subpath = "." + spec!.slice(pkg.length);
        const target = exports?.[subpath];
        if (!target) {
          fail(file, `import from "${spec}": no such package export`);
          continue;
        }
        if (clause!.startsWith("type ")) continue; // types leave no value to check
        const named = /\{([^}]*)\}/.exec(clause!)?.[1] ?? "";
        const values = named
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("type "))
          .map((s) => s.split(/\s+as\s+/)[0]!.trim());
        if (!values.length) continue;
        const mod = await load(target).catch(
          (e) =>
            void fail(
              file,
              `import from "${spec}": the module doesn't load (${e instanceof Error ? e.message.split("\n")[0] : e})`,
            ),
        );
        if (!mod) continue;
        for (const v of values)
          if (!(v in mod)) fail(file, `"${v}" is not exported by "${spec}"`);
      }
    }
  }
  for (const file of files)
    if (file !== skillFile && !linked.has(file))
      fail(file, "not linked from SKILL.md");
  console.log(`${name}: ${files.length} Markdown files checked`);
}

if (errors.length) {
  console.error(
    `\n${errors.length} problem${errors.length === 1 ? "" : "s"}:\n` +
      errors.map((e) => `  ✗ ${e}`).join("\n"),
  );
  process.exit(1);
}
console.log("✓ skills are in order");
