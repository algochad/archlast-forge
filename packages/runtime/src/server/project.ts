import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { AuthOptions, CronJob, FunctionKind, RegisteredFunction } from "../functions";
import type { SchemaDefinition } from "../schema";
import type { TablesSpec } from "./docstore";

const SPECIAL = new Set(["schema", "auth", "crons"]);

/** Function modules in a convex/ dir. `name` is the path without extension: "todos", "admin/users". */
export function listModules(convexDir: string): { name: string; file: string }[] {
  return [...new Bun.Glob("**/*.{ts,js}").scanSync({ cwd: convexDir })]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((f) => !f.split("/").some((seg) => seg.startsWith("_") || seg.startsWith(".") || seg === "node_modules"))
    .filter((f) => !/\.(test|spec|d)\.(ts|js)$/.test(f))
    .map((file) => ({ name: file.replace(/\.(ts|js)$/, ""), file }))
    .filter((m) => !SPECIAL.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Imports a user module, turning "Cannot find package" into an actionable error. */
export async function importUserModule(path: string, convexDir: string): Promise<any> {
  try {
    return await import(path);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const pkg = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(msg)?.[1];
    const file = relative(convexDir, path);
    if (pkg && !pkg.startsWith(".") && !pkg.startsWith("/")) {
      const name = pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split("/")[0];
      throw new Error(
        `convex/${file} imports "${pkg}", which is not installed. Add it to ${join(convexDir, "package.json")}: bun add --cwd ${convexDir} ${name}`,
      );
    }
    throw new Error(`Failed to load convex/${file}: ${msg}`, { cause: e });
  }
}

const isRegistered = (x: any): x is RegisteredFunction =>
  x && typeof x === "object" && ["query", "mutation", "action"].includes(x.kind) && typeof x.handler === "function";

export interface Project {
  tables: TablesSpec;
  functions: Map<string, RegisteredFunction>;
  authOptions: AuthOptions;
  crons: CronJob[];
}

export async function loadProject(convexDir: string): Promise<Project> {
  const schemaPath = join(convexDir, "schema.ts");
  if (!existsSync(schemaPath)) throw new Error(`No schema.ts in ${convexDir}`);
  const schema: SchemaDefinition<any> = (await importUserModule(schemaPath, convexDir)).default;
  if (!schema?.tables) throw new Error("convex/schema.ts must default-export defineSchema({...})");
  const tables: TablesSpec = Object.fromEntries(
    Object.entries(schema.tables).map(([name, t]: [string, any]) => [name, { fields: t.fields, indexes: t.indexes, strict: t.strict }]),
  );

  const functions = new Map<string, RegisteredFunction>();
  for (const mod of listModules(convexDir)) {
    const exports = await importUserModule(join(convexDir, mod.file), convexDir);
    for (const [name, value] of Object.entries(exports)) if (isRegistered(value)) functions.set(`${mod.name}:${name}`, value);
  }

  const optional = async (name: string) =>
    existsSync(join(convexDir, `${name}.ts`)) ? (await importUserModule(join(convexDir, `${name}.ts`), convexDir)).default : undefined;
  const authOptions: AuthOptions = (await optional("auth")) ?? { emailAndPassword: { enabled: true } };
  const crons: CronJob[] = (await optional("crons"))?.jobs ?? [];
  for (const job of crons) {
    const fn = functions.get(job.fn);
    if (!fn || fn.kind === "query") throw new Error(`Cron "${job.name}" targets ${fn ? "a query" : "unknown function"} "${job.fn}"`);
  }
  return { tables, functions, authOptions, crons };
}

export interface Manifest {
  functions: { name: string; kind: FunctionKind; args: Record<string, unknown>; returns?: unknown }[];
  tables: TablesSpec;
  crons: CronJob[];
  storage: boolean;
}
