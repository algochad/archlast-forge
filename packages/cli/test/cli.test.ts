import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFrontendImports, codegen } from "../src/codegen";
import { findForgeDir } from "../src/common";
import { ensureDeps } from "../src/deps";
import { loadProject } from "../../runtime/src/server/project";

const runtimeSrc = join(import.meta.dir, "../../runtime/src/index.ts");

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "afx-cli-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, forge: join(root, "forge") };
}

const schema = `import { defineSchema, defineTable, v } from ${JSON.stringify(runtimeSrc)};
export default defineSchema({ notes: defineTable({ body: v.string() }) });`;

test("codegen maps nested modules and skips special files", async () => {
  const { forge } = project({
    "forge/schema.ts": schema,
    "forge/notes.ts": "export const x = 1;",
    "forge/admin/users.ts": "export const y = 1;",
    "forge/crons.ts": "",
    "forge/_helpers.ts": "",
    "forge/notes.test.ts": "",
  });
  expect(await codegen(forge)).toEqual(["admin/users", "notes"]);
  const api = await Bun.file(join(forge, "_generated/api.ts")).text();
  expect(api).toContain(`import type * as m0_admin_users from "../admin/users";`);
  expect(api).toContain(`"admin": {\n    "users": ModuleRefs<typeof m0_admin_users, "public">;\n  };`);
  expect(api).toContain(`export const internal`);
  expect(await Bun.file(join(forge, "_generated/dataModel.ts")).text()).toContain("schema: typeof schema");
});

test("src/ may import forge/_generated but nothing else from forge/", async () => {
  const { forge } = project({
    "forge/schema.ts": schema,
    "src/ok.ts": `import { api } from "../forge/_generated/api";`,
    "src/bad.tsx": `import { secret } from "../forge/notes";\nexport const A = () => <div />;`,
  });
  const violations = await checkFrontendImports(forge);
  expect(violations.length).toBe(1);
  expect(violations[0]).toContain(`bad.tsx imports "../forge/notes"`);
});

test("missing server packages fail at load with an actionable error", async () => {
  const { forge } = project({ "forge/schema.ts": schema, "forge/mail.ts": `import { x } from "definitely-not-installed-pkg/sub";\nexport { x };` });
  await expect(loadProject(forge)).rejects.toThrow(`imports \"definitely-not-installed-pkg\", which is not installed`);
  await expect(loadProject(forge)).rejects.toThrow("bun add --cwd");
});

test("ensureDeps installs once, then again only when package.json changes", async () => {
  const { forge } = project({ "forge/package.json": JSON.stringify({ name: "c", dependencies: {} }) });
  expect(await ensureDeps(forge)).toBe(true);
  expect(await ensureDeps(forge)).toBe(false);
  writeFileSync(join(forge, "package.json"), JSON.stringify({ name: "c", dependencies: {}, description: "changed" }));
  expect(await ensureDeps(forge)).toBe(true);
});

test("the functions folder is forge/; a project still on the old convex/ name is found, with a nudge to rename it", () => {
  const cwd = process.cwd();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warnings.push(m);
  const inside = (files: Record<string, string>) => {
    const { root } = project(files);
    process.chdir(root);
    return realpathSync(root);
  };
  try {
    let root = inside({ "forge/schema.ts": schema });
    expect(findForgeDir()).toBe(join(root, "forge"));
    expect(warnings).toEqual([]);
    root = inside({ "convex/schema.ts": schema });
    expect(findForgeDir()).toBe(join(root, "convex"));
    expect(warnings[0]).toContain("Rename it to forge/");
    root = inside({ "forge/schema.ts": schema, "convex/schema.ts": schema }); // both: forge wins, and no nudge
    warnings.length = 0;
    expect(findForgeDir()).toBe(join(root, "forge"));
    expect(warnings).toEqual([]);
    root = inside({ "schema.ts": schema }); // already inside the folder
    expect(findForgeDir()).toBe(root);
    expect(findForgeDir(".")).toBe(root); // --dir is taken as given
  } finally {
    console.warn = warn;
    process.chdir(cwd);
  }
});
