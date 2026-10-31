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
  { dir: "framework", dist: true },
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
  cpSync(join(ROOT, "LICENSE"), join(target, "LICENSE"));
  // Code ported from other projects keeps their license notices with it.
  const notices = existsSync(join(src, "THIRD_PARTY_NOTICES.md"));
  if (notices) cpSync(join(src, "THIRD_PARTY_NOTICES.md"), join(target, "THIRD_PARTY_NOTICES.md"));
  if (existsSync(join(src, "README.md"))) cpSync(join(src, "README.md"), join(target, "README.md"));
  else
    writeFileSync(
      join(target, "README.md"),
      `# ${pkg.name}\n\n${pkg.description}\n\nPart of [archlast-forge](https://github.com/algochad/archlast-forge), a self-hosted reactive backend and full-stack framework for TypeScript on Bun. Start with \`bun create archlast-forge\`; the documentation is in the repository.\n\nMIT licensed.\n`,
    );

  const pin = (deps?: Record<string, string>) =>
    deps && Object.fromEntries(Object.entries(deps).map(([name, spec]) => [name, spec.startsWith("workspace:") ? `^${versions[name]}` : spec]));
  const exportsOut = dist
    ? Object.fromEntries(
        Object.entries(pkg.exports as Record<string, string>).map(([key, path]) => {
          const base = path.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, "");
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
    files: [...(dist ? ["dist"] : ["src", "template"].filter((f) => existsSync(join(src, f)))), ...(notices ? ["THIRD_PARTY_NOTICES.md"] : [])],
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

/** Scaffolds a project of `mode`, points it at the packed tarballs, and proves it: types, build, and a running production server. */
async function smoke(mode: "framework" | "backend") {
  const base = mkdtempSync(join(tmpdir(), `afx-smoke-${mode}-`));
  const app = join(base, `smoke-${mode}`);
  // Install the scaffolder the way a user's `bun create` would: from its tarball, with its own dependencies.
  const creator = mkdtempSync(join(tmpdir(), "afx-creator-"));
  process.on("exit", () => [base, creator].forEach((d) => rmSync(d, { recursive: true, force: true }))); // about 150 MB each
  writeFileSync(join(creator, "package.json"), "{}");
  run(["bun", "add", packed.find((p) => p.name === "create-archlast-forge")!.tarball], creator);
  run(["bun", join(creator, "node_modules", "create-archlast-forge", "src", "index.ts"), app, "--mode", mode, "--yes", "--no-install", "--no-git"], ROOT);
  // Resolve every @archlast/forge-* package (direct or transitive) to the local tarballs.
  const overrides = Object.fromEntries(packed.filter((p) => p.name.startsWith("@archlast/forge-") || p.name === "create-archlast-forge").map((p) => [p.name, `file:${p.tarball}`]));
  for (const file of [join(app, "package.json"), join(app, "forge", "package.json")]) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const field of ["dependencies", "devDependencies"]) for (const name of Object.keys(pkg[field] ?? {})) if (overrides[name]) pkg[field][name] = overrides[name];
    pkg.overrides = overrides;
    writeFileSync(file, JSON.stringify(pkg, null, 2));
  }
  run(["bun", "install"], app);
  run(["bunx", "archlast-forge", "codegen"], app);
  run(["bunx", "tsc", ...(mode === "framework" ? [] : ["-p", "forge"]), "--noEmit"], app);
  if (mode === "framework") run(["bunx", "archlast-forge", "build", "--no-docker"], app);

  const probe = Bun.serve({ port: 0, fetch: () => new Response() }); // a port the machine says is free; a random one sometimes collided on a busy runner
  const port = String(probe.port);
  await probe.stop(true);
  const server = Bun.spawn(["bunx", "archlast-forge", "start", "--no-docker"], {
    cwd: app,
    env: { ...process.env, PORT: port, DATA_DIR: join(app, "data"), BETTER_AUTH_SECRET: "x".repeat(40), ALLOW_INSECURE_HTTP: "1", ARCHLAST_NO_DOCKER: "1", BETTER_AUTH_URL: `http://localhost:${port}`, ADMIN_KEY: "k".repeat(32), DASHBOARD: "on" },
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await Bun.sleep(500);
      ready = await fetch(`http://localhost:${port}/ready`).then((r) => r.ok, () => false);
    }
    if (!ready) throw new Error(`packed ${mode} server never became ready`);
    const base = `http://localhost:${port}`;
    const args = encodeURIComponent(JSON.stringify({ paginationOpts: { numItems: 5, cursor: null } }));
    const body = (await (await fetch(`${base}/rpc/messages:list?args=${args}`)).json()) as any;
    if (!Array.isArray(body.result?.page)) throw new Error(`unexpected response: ${JSON.stringify(body)}`);
    if (mode === "framework") {
      const home = await (await fetch(`${base}/`)).text();
      if (!home.includes("<html") || !home.includes("Realtime. Full-stack. One deploy.")) throw new Error(`the home page isn't rendered: ${home.slice(0, 300)}`);
      const entry = /src="(\/_app\/[^"]+\.js)"/.exec(home)?.[1];
      if (!entry || !(await fetch(`${base}${entry}`)).ok) throw new Error("the page's script isn't served");
      const chat = await fetch(`${base}/chat`, { redirect: "manual" });
      if (chat.status !== 302 || chat.headers.get("location") !== "/sign-in") throw new Error(`/chat should send visitors to /sign-in, got ${chat.status}`);
      if ((await fetch(`${base}/no/such/page`)).status !== 404) throw new Error("unknown pages should be 404");
    } else {
      const hello = (await (await fetch(`${base}/http/hello`)).json()) as any;
      if (!String(hello.message).startsWith("Hello from")) throw new Error(`unexpected /http/hello: ${JSON.stringify(hello)}`);
    }
    // Telemetry from the packed engine (its store runs on a worker the build ships next to the server): the call above, read back through
    // the dashboard's API, and the dashboard itself, bundled from the packed source.
    const range = encodeURIComponent(JSON.stringify({ from: Date.now() - 600_000, to: Date.now() + 60_000 }));
    let ops: { operation: string }[] = [];
    for (let i = 0; i < 40 && !ops.some((o) => o.operation === "messages:list"); i++) {
      await Bun.sleep(250);
      ops = ((await (await fetch(`${base}/_admin/obs.requests?input=${range}`, { headers: { "x-admin-key": "k".repeat(32) } })).json()) as any).operations ?? [];
    }
    if (!ops.some((o) => o.operation === "messages:list")) throw new Error(`the call isn't in the packed engine's telemetry: ${JSON.stringify(ops)}`);
    const dashboard = await fetch(`${base}/_dashboard`);
    if (!dashboard.ok || !(await dashboard.text()).includes('<div id="root">')) throw new Error("the dashboard isn't served");
    console.log(`✓ smoke test (${mode}): scaffolded, installed from tarballs, typechecked${mode === "framework" ? ", built" : ""}, served ${app}, and read its telemetry back`);
  } finally {
    server.kill();
    await server.exited;
  }
}

if (process.argv.includes("--smoke")) {
  await smoke("framework");
  await smoke("backend");
}
