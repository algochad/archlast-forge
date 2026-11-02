// forge/_generated/rpc.ts: what the forge/ Forge RPC routers (@Router classes) serve, as the types other apps call them with. The schemas
// are values, so the routers are imported, in a process of its own (this file, run as a script), and their schemas turned into types
// through JSON Schema. A procedure without an output schema gets its method's return type.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RouterInfo {
  module: string;
  exportName: string;
  alias: string;
  procedures: { name: string; kind: "query" | "mutation"; input: string | null; output: string | null }[];
}

type Json = Record<string, any> | boolean | undefined;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const union = (parts: string[]) => [...new Set(parts)].join(" | ") || "never";

/** A JSON Schema (as Zod's toJSONSchema writes it) as a TypeScript type. */
export function tsOf(schema: Json, root: Json = schema, depth = 0): string {
  if (schema === undefined || schema === true) return "unknown";
  if (schema === false) return "never";
  // shortcut: a recursive schema ($ref back to itself) becomes unknown past this depth; emit named types if anyone needs them.
  if (depth > 24) return "unknown";
  const s = schema;
  const next = (x: Json) => tsOf(x, root, depth + 1);
  if (typeof s.$ref === "string") {
    const target = s.$ref === "#" ? root : s.$ref.startsWith("#/$defs/") && typeof root === "object" ? root.$defs?.[s.$ref.slice(8)] : undefined;
    return target === undefined ? "unknown" : next(target);
  }
  if ("const" in s) return JSON.stringify(s.const) ?? "unknown";
  if (Array.isArray(s.enum)) return union(s.enum.map((e: unknown) => JSON.stringify(e)));
  if (Array.isArray(s.anyOf ?? s.oneOf)) return union((s.anyOf ?? s.oneOf).map((x: Json) => next(x)));
  if (Array.isArray(s.allOf)) return s.allOf.map((x: Json) => `(${next(x)})`).join(" & ");
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties || s.additionalProperties ? ["object"] : s.items || s.prefixItems ? ["array"] : [];
  if (!types.length) return "unknown";
  return union(
    types.map((t) => {
      if (t === "string" || t === "boolean" || t === "null") return t;
      if (t === "number" || t === "integer") return "number";
      if (t === "array") {
        if (Array.isArray(s.prefixItems)) return `[${[...s.prefixItems.map((x: Json) => next(x)), ...(s.items ? [`...Array<${next(s.items)}>`] : [])].join(", ")}]`;
        return `Array<${next(s.items)}>`;
      }
      if (t === "object") {
        const required = new Set<string>(s.required ?? []);
        const props = Object.entries((s.properties ?? {}) as Record<string, Json>).map(([k, v]) => `${key(k)}${required.has(k) ? "" : "?"}: ${next(v)}`);
        const extra = s.additionalProperties;
        const record = extra && extra !== false ? `Record<string, ${extra === true ? "unknown" : next(extra)}>` : undefined;
        if (!props.length) return record ?? "{}";
        return record ? `{ ${props.join("; ")} } & ${record}` : `{ ${props.join("; ")} }`;
      }
      return "unknown";
    }),
  );
}

/** A schema's JSON Schema for `io`: Zod's own converter (which can say "any" for what JSON Schema can't hold), or Standard JSON Schema. */
function jsonSchemaOf(schema: any, io: "input" | "output"): Json {
  try {
    if (typeof schema?.toJSONSchema === "function") return schema.toJSONSchema({ io, unrepresentable: "any", target: "draft-2020-12" });
    const convert = schema?.["~standard"]?.jsonSchema;
    if (convert) return convert[io]({ target: "draft-2020-12" });
  } catch {}
  return undefined;
}

/** The forge/ modules that declare routers, imported in a process of their own, as their exports describe them. */
export async function rpcRouters(forgeDir: string, modules: { name: string; file: string }[]): Promise<RouterInfo[]> {
  const files = modules.filter((m) => /@Router\s*\(/.test(readFileSync(join(forgeDir, m.file), "utf8")));
  if (!files.length) return [];
  const out = join(tmpdir(), `archlast-forge-rpc-${process.pid}-${Bun.nanoseconds()}.json`);
  const run = Bun.spawn([process.execPath, import.meta.path, forgeDir, out, ...files.map((f) => f.file)], { stdout: "inherit", stderr: "pipe", env: process.env });
  const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
  try {
    if (code !== 0 || !existsSync(out)) throw new Error(`codegen: the Forge RPC routers didn't load:\n${stderr.trim()}`);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(out, { force: true });
  }
}

/** forge/_generated/rpc.ts for these routers. */
export function renderRpc(routers: RouterInfo[], header: string): string {
  const seen = new Map<string, string>();
  for (const r of routers) {
    const other = seen.get(r.alias);
    if (other) throw new Error(`codegen: ${other} and ${r.module}.ts ${r.exportName} both use the Forge RPC alias "${r.alias}"`);
    seen.set(r.alias, `${r.module}.ts ${r.exportName}`);
  }
  const imports = new Map<string, string>();
  const body = [...routers]
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((r) => {
      const procs = r.procedures.map((p) => {
        let output = p.output;
        if (output === null) {
          const id = imports.get(r.module) ?? `m${imports.size}`;
          imports.set(r.module, id);
          output = `Awaited<ReturnType<${id}.${r.exportName}[${JSON.stringify(p.name)}]>>`;
        }
        return `    ${key(p.name)}: { kind: "${p.kind}"; input: ${p.input ?? "undefined"}; output: ${output} };\n`;
      });
      return `  /** ${r.module}.ts: ${r.exportName} */\n  ${key(r.alias)}: {\n${procs.join("")}  };\n`;
    });
  return (
    header +
    [...imports].map(([m, id]) => `import type * as ${id} from "../${m}";\n`).join("") +
    `\n/** The Forge RPC routers this backend serves. Another app calls them with \`createForgeRpcClient<Rpc>({ url })\`. */\nexport interface Rpc {\n${body.join("")}}\n`
  );
}

if (import.meta.main) {
  const [forgeDir, out, ...files] = process.argv.slice(2) as [string, string, ...string[]];
  const { compileDecorators } = await import("@archlast/forge-runtime/server");
  compileDecorators(forgeDir);
  const RPC_ROUTER = Symbol.for("archlast-forge.rpc.router");
  const routers: RouterInfo[] = [];
  for (const file of files) {
    const mod = await import(join(forgeDir, file));
    for (const [exportName, value] of Object.entries(mod)) {
      const meta = (value as Record<symbol, { alias: string; procedures: Record<string, { kind: "query" | "mutation"; input?: unknown; output?: unknown }> }> | null)?.[RPC_ROUTER];
      if (!meta || typeof value !== "function") continue;
      routers.push({
        module: file.replace(/\.(ts|js)$/, ""),
        exportName,
        alias: meta.alias,
        procedures: Object.entries(meta.procedures).map(([name, p]) => ({
          name,
          kind: p.kind,
          input: p.input ? tsOf(jsonSchemaOf(p.input, "input")) : null,
          output: p.output ? tsOf(jsonSchemaOf(p.output, "output")) : null,
        })),
      });
    }
  }
  await Bun.write(out, JSON.stringify(routers));
  process.exit(0); // a router's imports may leave handles open
}
