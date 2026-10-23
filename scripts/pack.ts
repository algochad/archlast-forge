#!/usr/bin/env bun
// Builds publishable tarballs into .pack/. Libraries ship dist/ (JS + .d.ts); Bun-run packages (cli, dashboard,
// create-archlast-forge) ship source. --smoke installs the tarballs into a fresh project and runs it.
//   bun scripts/pack.ts [--smoke]        publish: for f in .pack/*.tgz; do npm publish "$f"; done
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".pack");
const PACKAGES = [
  { dir: "runtime", dist: true },
  { dir: "client", dist: true },
  { dir: "react", dist: true },
  { dir: "vue", dist: true },
  { dir: "svelte", dist: true },
  { dir: "dashboard", dist: false },
  { dir: "cli", dist: false },
  { dir: "create-archlast-forge", dist: false },
];

const run = (cmd: string[], cwd: string, env: Record<string, string | undefined> = process.env) => {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
};

const versions = Object.fromEntries(
  PACKAGES.map(({ dir }) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
    return [pkg.name, pkg.version as string];
  }),
);

function stage(dir: string, dist: boolean) {
  const src = join(ROOT, "packages", dir);
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  if (dist) run(["bun", "run", "build"], src);
  const target = join(OUT, "stage", dir);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const entry of dist ? ["dist"] : ["src", "template"]) if (existsSync(join(src, entry))) cpSync(join(src, entry), join(target, entry), { recursive: true });
  for (const f of ["README.md", "LICENSE"]) if (existsSync(join(src, f))) cpSync(join(src, f), join(target, f));

  const pin = (deps?: Record<string, string>) =>
    deps && Object.fromEntries(Object.entries(deps).map(([name, spec]) => [name, spec.startsWith("workspace:") ? `^${versions[name]}` : spec]));
  const exportsOut = dist
    ? Object.fromEntries(
        Object.entries(pkg.exports as Record<string, string>).map(([key, path]) => {
          const base = path.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
          return [key, { types: `${base}.d.ts`, import: `${base}.js` }];
        }),
      )
    : pkg.exports;
  const { private: _p, devDependencies: _d, scripts: _s, ...rest } = pkg;
  const out = {
    ...rest,
    ...(exportsOut && { exports: exportsOut }),
    dependencies: pin(pkg.dependencies),
    peerDependencies: pin(pkg.peerDependencies),
    files: dist ? ["dist"] : ["src", "template"].filter((f) => existsSync(join(src, f))),
    publishConfig: { access: "public" },
  };
  writeFileSync(join(target, "package.json"), JSON.stringify(out, null, 2) + "\n");
  run(["bun", "pm", "pack", "--destination", OUT, "--quiet"], target);
  return { name: pkg.name as string, tarball: join(OUT, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`) };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const packed = PACKAGES.map(({ dir, dist }) => stage(dir, dist));
for (const p of packed) if (!existsSync(p.tarball)) throw new Error(`expected ${p.tarball}`);
console.log(`✓ packed ${packed.length} packages into ${OUT}`);

if (process.argv.includes("--smoke")) {
  const app = join(mkdtempSync(join(tmpdir(), "afx-smoke-")), "smoke-app");
  run(["bun", join(OUT, "stage", "create-archlast-forge", "src", "index.ts"), app], ROOT);
  // Resolve every @archlast-forge package (direct or transitive) to the local tarballs.
  const overrides = Object.fromEntries(packed.filter((p) => p.name.startsWith("@archlast-forge/")).map((p) => [p.name, `file:${p.tarball}`]));
  for (const file of [join(app, "package.json"), join(app, "forge", "package.json")]) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const field of ["dependencies", "devDependencies"]) for (const name of Object.keys(pkg[field] ?? {})) if (overrides[name]) pkg[field][name] = overrides[name];
    pkg.overrides = overrides;
    writeFileSync(file, JSON.stringify(pkg, null, 2));
  }
  run(["bun", "install"], app);
  run(["bunx", "archlast-forge", "codegen"], app);
  run(["bunx", "tsc", "--noEmit"], app);
  run(["bunx", "vite", "build"], app);

  const port = String(40000 + Math.floor(Math.random() * 20000));
  const server = Bun.spawn(["bunx", "archlast-forge", "start", "--no-docker"], {
    cwd: app,
    env: { ...process.env, PORT: port, DATA_DIR: join(app, "data"), BETTER_AUTH_SECRET: "x".repeat(40), ALLOW_INSECURE_HTTP: "1", ARCHLAST_NO_DOCKER: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await Bun.sleep(500);
      ready = await fetch(`http://localhost:${port}/ready`).then((r) => r.ok, () => false);
    }
    if (!ready) throw new Error("packed server never became ready");
    const input = encodeURIComponent(JSON.stringify({ paginationOpts: { numItems: 5, cursor: null } }));
    const body = (await (await fetch(`http://localhost:${port}/trpc/messages.list?input=${input}`)).json()) as any;
    if (!Array.isArray(body.result?.data?.page)) throw new Error(`unexpected response: ${JSON.stringify(body)}`);
    console.log(`✓ smoke test: scaffolded, installed from tarballs, typechecked, built and served ${app}`);
  } finally {
    server.kill();
    await server.exited;
  }
}
