// forge/_generated/authTables.ts: the tables of the Better Auth plugins forge/auth.ts uses (`@archlast/forge-runtime/auth`), which the
// engine declares for them, so the data model's types include them. forge/auth.ts and schema.ts are imported in a process of their own.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The source of authTables.ts, or null when forge/auth.ts uses no plugin with tables of its own. */
export async function authTablesSource(forgeDir: string): Promise<string | null> {
  const file = join(forgeDir, "auth.ts");
  if (!existsSync(file) || !/\bplugins\s*:/.test(readFileSync(file, "utf8"))) return null;
  const out = join(tmpdir(), `archlast-forge-auth-${process.pid}-${Bun.nanoseconds()}.ts`);
  const run = Bun.spawn([process.execPath, import.meta.path, forgeDir, out], { stdout: "inherit", stderr: "pipe", env: process.env });
  const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
  try {
    if (code !== 0 || !existsSync(out)) throw new Error(`codegen: forge/auth.ts didn't load:\n${stderr.trim()}`);
    return readFileSync(out, "utf8") || null;
  } finally {
    rmSync(out, { force: true });
  }
}

if (import.meta.main) {
  const [forgeDir, out] = process.argv.slice(2) as [string, string];
  const { compileDecorators, pluginTablesSource } = await import("@archlast/forge-runtime/server");
  compileDecorators(forgeDir);
  const auth = (await import(join(forgeDir, "auth.ts"))).default;
  const schema = existsSync(join(forgeDir, "schema.ts")) ? (await import(join(forgeDir, "schema.ts"))).default : undefined;
  await Bun.write(out, pluginTablesSource(auth, Object.keys(schema?.tables ?? {})) ?? "");
  process.exit(0); // a plugin's imports may leave handles open
}
