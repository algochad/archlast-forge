#!/usr/bin/env bun
// Builds the native library (Rust) into native/, and with --test runs the tests on it.
// Without a Rust toolchain it says so and succeeds: the runtime then keeps its SQLite on bun:sqlite, as it does wherever the native library is missing,
// so a machine that only has Bun can still install, typecheck and test the rest of the repository.
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const run = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
};

if (!Bun.which("cargo")) {
  console.log("[db] no Rust toolchain here: the native database layer is not built (the runtime keeps bun:sqlite)");
  process.exit(0);
}
run(["./build.sh"]);
if (process.argv.includes("--test")) {
  if (!existsSync(join(root, "native", "archlast_db.node"))) throw new Error("native/archlast_db.node was not built");
  run(["bun", "test"]);
}
