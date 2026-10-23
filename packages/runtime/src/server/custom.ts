import { ForgeError } from "../errors";
import { mutation, query, type RegisteredFunction } from "../functions";
import { v } from "../values";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;

export class CustomCodeError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

const newlines = (s: string) => "\n".repeat(s.split("\n").length - 1);

/**
 * Turns the dashboard's editor text into a function. The text looks like a function file:
 *
 *     export default query({ args: { n: v.number() }, handler: async (ctx, { n }) => ctx.db.query("todos").take(n) });
 *
 * `query`, `mutation`, `v` and `ForgeError` are in scope, so imports are dropped. TypeScript is allowed.
 * A bare `export default async (ctx, args) => …` counts as a query.
 */
export async function compileCustom(source: string): Promise<RegisteredFunction> {
  // Keep every newline so a syntax error's line number still points at the editor's line.
  const withoutImports = source.replace(/^[ \t]*import\s[^;]*?['"][^'"]+['"][ \t]*;?[ \t]*$/gm, newlines);
  let js: string;
  try {
    js = transpiler.transformSync(withoutImports);
  } catch (e) {
    // Bun throws a BuildMessage: the problem and where it is (1-based line).
    const m = e as { message: string; position?: { line: number } | null };
    throw new CustomCodeError(m.message, m.position?.line);
  }
  const body = js
    .replace(/^export\s*\{[^}]*\}\s*;?[ \t]*$/gm, "")
    .replace(/^export\s+default\s+/m, "return ")
    .replace(/^export\s+(?!default)/gm, "");
  let result: unknown;
  try {
    result = await new AsyncFunction("query", "mutation", "v", "ForgeError", body)(query, mutation, v, ForgeError);
  } catch (e) {
    throw new CustomCodeError(`${(e as Error).name}: ${(e as Error).message}`);
  }
  if (typeof result === "function") return query({ handler: result as never }); // a bare function is a query
  const fn = result as RegisteredFunction | undefined;
  if (!fn || typeof fn.handler !== "function" || !fn.kind) throw new CustomCodeError("Export a function: export default query({ handler: async (ctx) => … })");
  if (fn.kind === "action") throw new CustomCodeError("Custom functions can be a query or a mutation");
  if (fn.visibility === "internal") throw new CustomCodeError("Use query or mutation, not internalQuery or internalMutation");
  return fn;
}
