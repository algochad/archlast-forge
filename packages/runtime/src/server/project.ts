import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { AuthOptions, CronJob, FunctionKind, HttpRoute, RegisteredFunction } from "../functions";
import type { SchemaDefinition } from "../schema";
import type { TablesSpec } from "./docstore";

const SPECIAL = new Set(["schema", "auth", "crons", "http"]);

/** Function modules in a forge/ dir. `name` is the path without extension: "todos", "admin/users". */
export function listModules(forgeDir: string): { name: string; file: string }[] {
  return [...new Bun.Glob("**/*.{ts,js}").scanSync({ cwd: forgeDir })]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((f) => !f.split("/").some((seg) => seg.startsWith("_") || seg.startsWith(".") || seg === "node_modules"))
    .filter((f) => !/\.(test|spec|d)\.(ts|js)$/.test(f))
    .map((file) => ({ name: file.replace(/\.(ts|js)$/, ""), file }))
    .filter((m) => !SPECIAL.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Imports a user module, turning "Cannot find package" into an actionable error. */
export async function importUserModule(path: string, forgeDir: string): Promise<any> {
  try {
    return await import(path);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const pkg = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(msg)?.[1];
    const file = relative(forgeDir, path);
    if (pkg && !pkg.startsWith(".") && !pkg.startsWith("/")) {
      const name = pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split("/")[0];
      throw new Error(
        `forge/${file} imports "${pkg}", which is not installed. Add it to ${join(forgeDir, "package.json")}: bun add --cwd ${forgeDir} ${name}`,
      );
    }
    throw new Error(`Failed to load forge/${file}: ${msg}`, { cause: e });
  }
}

const isRegistered = (x: any): x is RegisteredFunction =>
  x && typeof x === "object" && ["query", "mutation", "action"].includes(x.kind) && typeof x.handler === "function";

export interface Project {
  tables: TablesSpec;
  functions: Map<string, RegisteredFunction>;
  authOptions: AuthOptions;
  crons: CronJob[];
  http: HttpRoute[];
}

export async function loadProject(forgeDir: string): Promise<Project> {
  const schemaPath = join(forgeDir, "schema.ts");
  if (!existsSync(schemaPath)) throw new Error(`No schema.ts in ${forgeDir}`);
  const schema: SchemaDefinition<any> = (await importUserModule(schemaPath, forgeDir)).default;
  if (!schema?.tables) throw new Error("forge/schema.ts must default-export defineSchema({...})");
  const tables: TablesSpec = Object.fromEntries(
    Object.entries(schema.tables).map(([name, t]: [string, any]) => [
      name,
      { fields: t.fields, indexes: t.indexes, searchIndexes: t.searchIndexes ?? {}, strict: t.strict },
    ]),
  );

  const functions = new Map<string, RegisteredFunction>();
  for (const mod of listModules(forgeDir)) {
    const exports = await importUserModule(join(forgeDir, mod.file), forgeDir);
    for (const [name, value] of Object.entries(exports)) if (isRegistered(value)) functions.set(`${mod.name}:${name}`, value);
  }

  const optional = async (name: string) =>
    existsSync(join(forgeDir, `${name}.ts`)) ? (await importUserModule(join(forgeDir, `${name}.ts`), forgeDir)).default : undefined;
  const authOptions: AuthOptions = (await optional("auth")) ?? { emailAndPassword: { enabled: true } };
  const crons: CronJob[] = (await optional("crons"))?.jobs ?? [];
  for (const job of crons) {
    const fn = functions.get(job.fn);
    if (!fn || fn.kind === "query") throw new Error(`Cron "${job.name}" targets ${fn ? "a query" : "unknown function"} "${job.fn}"`);
  }
  const router = await optional("http");
  if (router && !Array.isArray(router.routes)) throw new Error("forge/http.ts must default-export httpRouter()");
  return { tables, functions, authOptions, crons, http: router?.routes ?? [] };
}

export const tableSpecs = (tables: TablesSpec) =>
  Object.entries(tables).map(([name, t]) => ({ name, indexes: t.indexes, searchIndexes: t.searchIndexes }));

export interface Manifest {
  functions: { name: string; kind: FunctionKind; visibility: "public" | "internal"; args: Record<string, unknown>; returns?: unknown }[];
  tables: TablesSpec;
  crons: CronJob[];
  storage: boolean;
}
