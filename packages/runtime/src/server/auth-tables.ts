// The tables Better Auth's plugins need, derived from the plugins an app passes to defineAuth({ plugins }), so the app doesn't declare them.
// Each plugin describes its models (`plugin.schema`): the fields, which are required, unique or indexed, and what they reference. The
// document adapter stores a model as its name plus "s" (usePlural), dates as numbers, and writes null for an optional field it leaves empty.
import type { AuthOptions } from "../functions";
import { defineTable, type TableDefinition } from "../schema";
import { v, type Validator } from "../values";

type FieldAttribute = { type?: unknown; required?: boolean; unique?: boolean; index?: boolean; references?: unknown; fieldName?: string };
type PluginSchema = Record<string, { modelName?: string; fields?: Record<string, FieldAttribute> }>;

/** Better Auth's own models: built into every schema already; the fields a plugin adds to them are stored as they come. */
const BUILT_IN = new Set(["user", "session", "account", "verification"]);

/** The table a model is stored in. */
export const tableOfModel = (model: string) => `${model}s`;

function validatorOf(type: unknown): Validator<unknown, false> {
  if (Array.isArray(type) || type === "string[]") return v.array(v.string());
  if (type === "number[]") return v.array(v.number());
  if (type === "string") return v.string();
  if (type === "number" || type === "date") return v.number();
  if (type === "boolean") return v.boolean();
  return v.any(); // "json", and anything a plugin defines that has no validator of its own
}

/** What a plugin's model describes, as one table. */
function tableOf(fields: Record<string, FieldAttribute>): TableDefinition<any, any> {
  const shape: Record<string, Validator> = {};
  const indexed: string[] = [];
  for (const [key, a] of Object.entries(fields)) {
    const name = a.fieldName ?? key;
    const t = validatorOf(a.type);
    shape[name] = a.required === false ? v.optional(v.union(t, v.null())) : t;
    if (a.unique || a.index || a.references) indexed.push(name);
  }
  let table: TableDefinition<any, any> = defineTable(shape);
  for (const f of indexed) table = table.index(`by_${f}`, [f]);
  return table;
}

/**
 * The tables of the plugins in `auth`, by table name, leaving out the ones `declared` (an app that declared a plugin's tables itself, as
 * the docs said before, keeps its own). Two plugins that describe the same model (the JWT plugin's `jwks`) give it once, its fields merged.
 */
export function pluginTables(auth: Pick<AuthOptions, "plugins"> | undefined, declared: Iterable<string> = []): Record<string, TableDefinition<any, any>> {
  const skip = new Set(declared);
  const models = new Map<string, Record<string, FieldAttribute>>();
  for (const plugin of ((auth as { plugins?: { schema?: PluginSchema }[] } | undefined)?.plugins ?? []))
    for (const [model, def] of Object.entries(plugin?.schema ?? {})) {
      if (BUILT_IN.has(model)) continue;
      const name = tableOfModel(def.modelName ?? model);
      if (skip.has(name)) continue;
      models.set(name, { ...models.get(name), ...def.fields });
    }
  return Object.fromEntries([...models].map(([name, fields]) => [name, tableOf(fields)]));
}

/** A derived validator as the source that builds it (the kinds `validatorOf` makes, optional or with null). */
function sourceOf(t: Validator<unknown, boolean>): string {
  const inner = (x: Validator<unknown, boolean>): string => {
    const any = x as unknown as { kind: string; element?: Validator; members?: Validator[] };
    switch (any.kind) {
      case "array":
        return `v.array(${inner(any.element!)})`;
      case "union":
        return `v.union(${any.members!.map(inner).join(", ")})`;
      case "string":
      case "number":
      case "boolean":
      case "null":
      case "any":
        return `v.${any.kind}()`;
      default:
        return "v.any()";
    }
  };
  return t.optional ? `v.optional(${inner(t)})` : inner(t);
}

/**
 * The same tables as TypeScript, for codegen: `forge/_generated/authTables.ts` declares them with defineTable so the data model's types
 * include them (`ctx.db.query("members")`). Null when there are none.
 */
export function pluginTablesSource(auth: Pick<AuthOptions, "plugins"> | undefined, declared: Iterable<string> = []): string | null {
  const tables = Object.entries(pluginTables(auth, declared));
  if (!tables.length) return null;
  const lines = tables.map(([name, t]) => {
    const fields = Object.entries(t.fields as Record<string, Validator<unknown, boolean>>).map(([f, val]) => `${f}: ${sourceOf(val)}`);
    const indexes = Object.entries(t.indexes as Record<string, readonly string[]>).map(([i, fs]) => `.index(${JSON.stringify(i)}, ${JSON.stringify(fs)})`);
    return `  ${name}: defineTable({ ${fields.join(", ")} })${indexes.join("")},`;
  });
  return `import { defineTable, v } from "@archlast/forge-runtime";\n\n/** The tables of the Better Auth plugins in forge/auth.ts, which the engine declares for them. */\nexport const authPluginTables = {\n${lines.join("\n")}\n};\n`;
}
