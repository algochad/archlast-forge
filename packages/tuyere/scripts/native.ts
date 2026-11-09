#!/usr/bin/env bun
// Builds the native libraries (Rust + a small C++ shim) into native/, and with --test runs the tests on them.
// Without a Rust and C++ toolchain it says so and succeeds: the runtime then serves with Bun.serve, as it does wherever the
// native library is missing, so a machine that only has Bun can still install, typecheck and test the rest of the repository.
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const toolchain = Boolean(
  Bun.which("cargo") && (Bun.which("g++") || Bun.which("c++")),
);
const run = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
};

if (!toolchain) {
  console.log(
    "[serve] no Rust/C++ toolchain here: the native engine is not built (the runtime falls back to Bun.serve)",
  );
  process.exit(0);
}
run(["./build.sh"]);
if (process.argv.includes("--test")) {
  if (!existsSync(join(root, "native", "tuyere.node")))
    throw new Error("native/tuyere.node was not built");
  run(["bun", "test"]);
}
