import type { HelmetConfig } from "../functions";
import { checkHelmetConfig } from "./security-headers";
import { checkRouteDocs, docsRouting, type ApiDocsConfig, type ApiDocsRouting } from "../api-docs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { AuthOptions, CronJob, FunctionKind, HttpRoute, RegisteredFunction } from "../functions";
import type { SchemaDefinition } from "../schema";
import type { TablesSpec } from "./docstore";
import { reservedPathOf } from "./config";

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

const decorated = new Set<string>();
const DECORATOR = /^\s*@[A-Za-z_$]|[(,]\s*@[A-Za-z_$]/m;

/**
 * Compiles forge/ files that use decorators (Nest's controllers and services) with experimentalDecorators and emitDecoratorMetadata.
 * Bun applies the tsconfig of the directory the process runs in, not forge/tsconfig.json, so the engine sets them itself. Each such file
 * is built on its own with every import left external, and an inline source map keeps its stack traces on the right lines.
 */
export function compileDecorators(forgeDir: string) {
  if (decorated.has(forgeDir)) return;
  decorated.add(forgeDir);
  const dir = join(tmpdir(), "archlast-forge");
  mkdirSync(dir, { recursive: true });
  const tsconfig = join(dir, `decorators-${Bun.hash(forgeDir).toString(36)}.json`);
  const base = join(forgeDir, "tsconfig.json");
  writeFileSync(tsconfig, JSON.stringify({ ...(existsSync(base) && { extends: base }), compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }));
  const files = new RegExp(`^${forgeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!.*node_modules/).*\\.tsx?$`);
  Bun.plugin({
    name: "archlast-forge decorators",
    setup(build) {
      build.onLoad({ filter: files }, async ({ path }) => {
        const source = await Bun.file(path).text();
        if (!DECORATOR.test(source)) return { contents: source, loader: path.endsWith("x") ? "tsx" : "ts" };
        const out = await Bun.build({ entrypoints: [path], target: "bun", external: ["*"], sourcemap: "inline", tsconfig } as Parameters<typeof Bun.build>[0]);
        if (!out.success) throw new AggregateError(out.logs, `forge/${relative(forgeDir, path)} did not compile`);
        // The map's source is relative to where Bun built it from; point it at the file, so stack traces name the right one.
        const code = await out.outputs[0]!.text();
        return {
          loader: "js",
          contents: code.replace(/(\/\/# sourceMappingURL=data:application\/json;base64,)(\S+)/, (_, head, map) => {
            const json = JSON.parse(Buffer.from(map, "base64").toString("utf8"));
            json.sources = [path];
            return head + Buffer.from(JSON.stringify(json)).toString("base64");
          }),
        };
      });
    },
  });
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
  /** forge/http.ts's router serves its routes at the root as well as under /http (`httpRouter({ root: true })`). */
  httpRoot?: boolean;
  /** The security headers' options from code: `http.helmet()`, and `nest(http, { helmet })` for the API. */
  helmet?: HelmetConfig;
  /** What forge/http.ts's `http.docs()` said. */
  docs?: ApiDocsConfig;
}

export async function loadProject(forgeDir: string): Promise<Project> {
  compileDecorators(forgeDir);
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
  const httpRoot = router?.root === true;
  if (httpRoot)
    for (const r of router.routes as HttpRoute[]) {
      const at = r.path ?? r.pathPrefix!;
      const taken = at === "/" ? undefined : reservedPathOf(at.replace(/\/$/, ""));
      if (taken) throw new Error(`forge/http.ts: ${r.method} ${at} can't be served at the root, where ${taken} is the engine's. Give it another path, or leave it under /http (httpRouter() without root).`);
    }
  // Code's security headers: http.helmet(), with nest(http, { helmet }) for the REST API. Plain data, since they cross into the server.
  const mount = ((router?.routes ?? []) as HttpRoute[]).find((r) => (r.handler as unknown as Record<symbol, unknown>)[Symbol.for("archlast-forge.nest-mount")]);
  const nestHelmet = mount && (mount.handler as unknown as Record<symbol, unknown>)[Symbol.for("archlast-forge.nest-helmet")];
  const helmet: HelmetConfig | undefined = router?.helmetConfig || nestHelmet !== undefined ? { ...router?.helmetConfig, ...(nestHelmet !== undefined && { api: nestHelmet as HelmetConfig["api"] }) } : undefined;
  if (helmet) checkHelmetConfig("forge/http.ts", helmet);
  const docs = router?.docsConfig as ApiDocsConfig | undefined;
  for (const r of (router?.routes ?? []) as HttpRoute[]) checkRouteDocs(`forge/http.ts: ${r.method} ${r.path ?? r.pathPrefix}`, r, docs);
  if (docs) {
    const at = docsRouting(docs);
    for (const [key, p] of [["path", at.path], ["openapi", at.openapi], ["explorer", at.explorer]] as const) {
      const taken = p && reservedPathOf(p);
      if (taken) throw new Error(`forge/http.ts: http.docs({ ${key}: "${p}" }) is under ${taken}, which the engine serves`);
    }
  }
  return { tables, functions, authOptions, crons, http: (router?.routes ?? []) as HttpRoute[], httpRoot, helmet, docs };
}

export const tableSpecs = (tables: TablesSpec) =>
  Object.entries(tables).map(([name, t]) => ({ name, indexes: t.indexes, searchIndexes: t.searchIndexes }));

export interface Manifest {
  functions: { name: string; kind: FunctionKind; visibility: "public" | "internal"; args: Record<string, unknown>; returns?: unknown; access?: true }[];
  tables: TablesSpec;
  crons: CronJob[];
  storage: boolean;
  /** What is deployed: a version the environment names, or a hash of the forge/ code. Telemetry compares traffic either side of a change. */
  release?: string;
  /** forge/http.ts's routes (method and path only) when its router serves them at the root too (`httpRouter({ root: true })`). */
  rootRoutes?: Pick<HttpRoute, "method" | "path" | "pathPrefix">[];
  /** The security headers' options from code (`http.helmet()`, `nest(http, { helmet })`). */
  helmet?: HelmetConfig;
  /** Where the API docs are, from `http.docs()` (or the defaults). */
  docs?: ApiDocsRouting;
}

/** Variables deploy platforms and CI set to the commit being deployed, in the order they are trusted. */
const RELEASE_VARS = ["FORGE_RELEASE", "RELEASE", "OTEL_SERVICE_VERSION", "SOURCE_VERSION", "SOURCE_COMMIT", "GIT_COMMIT", "COMMIT_SHA", "GITHUB_SHA", "RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA", "RAILWAY_GIT_COMMIT_SHA", "COOLIFY_GIT_COMMIT_SHA"];

/** The release a runtime runs: the deploy's commit when the environment says it (shortened like git does), else a hash of forge/'s files. */
export function releaseOf(forgeDir: string, env: Record<string, string | undefined>): string {
  for (const name of RELEASE_VARS) {
    const v = env[name]?.trim();
    if (v) return /^[0-9a-f]{40}$/i.test(v) ? v.slice(0, 7).toLowerCase() : v.slice(0, 64);
  }
  const hasher = new Bun.CryptoHasher("sha256");
  const files = [...new Bun.Glob("**/*.{ts,tsx,js,mjs,json}").scanSync({ cwd: forgeDir })]
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.split("/").some((seg) => seg === "node_modules" || seg === "_generated" || seg.startsWith(".")))
    .sort();
  for (const f of files) hasher.update(f).update(readFileSync(join(forgeDir, f)));
  return hasher.digest("hex").slice(0, 7);
}
