import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../src/index";

test("scaffolds a project with the name and versions filled in", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "afx-create-")), "My Chat");
  scaffold(dir, "1.2.3");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  expect(pkg.name).toBe("my-chat");
  expect(pkg.dependencies["@archlast-forge/react"]).toBe("^1.2.3");
  expect(existsSync(join(dir, ".gitignore"))).toBe(true);
  expect(existsSync(join(dir, "forge/schema.ts"))).toBe(true);
  expect(readFileSync(join(dir, "forge/package.json"), "utf8")).toContain('"@archlast-forge/runtime": "^1.2.3"');
  expect(() => scaffold(dir)).toThrow("isn't empty");
});
