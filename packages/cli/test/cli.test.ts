import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFrontendImports, codegen } from "../src/codegen";
import { ensureDeps } from "../src/deps";
import { loadProject } from "../../runtime/src/server/project";

const runtimeSrc = join(import.meta.dir, "../../runtime/src/index.ts");

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "afx-cli-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, convex: join(root, "convex") };
}

const schema = `import { defineSchema, defineTable, v } from ${JSON.stringify(runtimeSrc)};
export default defineSchema({ notes: defineTable({ body: v.string() }) });`;

test("codegen maps nested modules and skips special files", async () => {
  const { convex } = project({
    "convex/schema.ts": schema,
    "convex/notes.ts": "export const x = 1;",
    "convex/admin/users.ts": "export const y = 1;",
    "convex/crons.ts": "",
    "convex/_helpers.ts": "",
    "convex/notes.test.ts": "",
  });
  expect(await codegen(convex)).toEqual(["admin/users", "notes"]);
  const api = await Bun.file(join(convex, "_generated/api.ts")).text();
  expect(api).toContain(`import type * as m0_admin_users from "../admin/users";`);
  expect(api).toContain(`"admin": {\n    "users": ModuleRefs<typeof m0_admin_users, "public">;\n  };`);
  expect(api).toContain(`export const internal`);
  expect(await Bun.file(join(convex, "_generated/dataModel.ts")).text()).toContain("schema: typeof schema");
});

test("src/ may import convex/_generated but nothing else from convex/", async () => {
  const { convex } = project({
    "convex/schema.ts": schema,
    "src/ok.ts": `import { api } from "../convex/_generated/api";`,
    "src/bad.tsx": `import { secret } from "../convex/notes";\nexport const A = () => <div />;`,
  });
  const violations = await checkFrontendImports(convex);
  expect(violations.length).toBe(1);
  expect(violations[0]).toContain(`bad.tsx imports "../convex/notes"`);
});

test("missing server packages fail at load with an actionable error", async () => {
  const { convex } = project({ "convex/schema.ts": schema, "convex/mail.ts": `import { x } from "definitely-not-installed-pkg/sub";\nexport { x };` });
  await expect(loadProject(convex)).rejects.toThrow(`imports \"definitely-not-installed-pkg\", which is not installed`);
  await expect(loadProject(convex)).rejects.toThrow("bun add --cwd");
});

test("ensureDeps installs once, then again only when package.json changes", async () => {
  const { convex } = project({ "convex/package.json": JSON.stringify({ name: "c", dependencies: {} }) });
  expect(await ensureDeps(convex)).toBe(true);
  expect(await ensureDeps(convex)).toBe(false);
  writeFileSync(join(convex, "package.json"), JSON.stringify({ name: "c", dependencies: {}, description: "changed" }));
  expect(await ensureDeps(convex)).toBe(true);
});
