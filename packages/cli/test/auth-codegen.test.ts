import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authTablesSource } from "../src/auth-types";
import { codegen } from "../src/codegen";

// The Better Auth plugins forge/auth.ts uses bring their tables, and codegen gives them types (forge/_generated/authTables.ts).
const fixture = join(import.meta.dir, "../../runtime/test/fixture-auth-plugins");

test("codegen declares the plugins' tables for the types, the way the engine stores them", async () => {
  const source = (await authTablesSource(fixture))!;
  expect(source).toContain(`members: defineTable({ organizationId: v.string(), userId: v.string(), role: v.string(), createdAt: v.number() }).index("by_organizationId", ["organizationId"]).index("by_userId", ["userId"]),`);
  expect(source).toContain("jwkss: defineTable(");
  expect(source).toContain("oauthClients: defineTable(");
  expect(source).not.toContain("notes:"); // the app's own table stays in schema.ts
  // The committed generated files are what codegen writes (the fixture is type-checked with them).
  const before = ["authTables.ts", "dataModel.ts"].map((f) => readFileSync(join(fixture, "_generated", f), "utf8"));
  await codegen(fixture);
  expect(["authTables.ts", "dataModel.ts"].map((f) => readFileSync(join(fixture, "_generated", f), "utf8"))).toEqual(before);
  expect(before[1]).toContain(`schema: SchemaDefinition<(typeof schema)["tables"] & typeof authPluginTables>;`);
});

test("a project without such plugins gets no authTables.ts and the data model it always had", async () => {
  expect(await authTablesSource(join(import.meta.dir, "../../runtime/test/fixture"))).toBeNull();
  expect(await authTablesSource(join(import.meta.dir, "../../runtime/test/fixture-access-plugin"))).toBeNull();
});
