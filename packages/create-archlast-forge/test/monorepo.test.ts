import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { codegen } from "../../cli/src/codegen";
import { startServer } from "../../runtime/src/server/server";
import { parseFlags } from "../src/options";
import { parseMicroservices, scaffoldMonorepo } from "../src/monorepo";

setDefaultTimeout(120_000); // scaffolds run Prettier, and the services start for real

// Inside the repository, so the generated code finds the workspace's packages as an installed project would.
const scratch = join(import.meta.dir, ".tmp-monorepo");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const freePort = async () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  await s.stop(true);
  return port;
};

test("flags: --microservices and --transport make a monorepo, and names are checked", () => {
  expect(parseFlags(["x", "--microservices", "orders,billing", "--transport", "redis"])).toMatchObject({ monorepo: true, microservices: ["orders", "billing"], transport: "redis" });
  expect(parseFlags(["x", "--monorepo"])).toMatchObject({ monorepo: true });
  expect(() => parseFlags(["x", "--transport", "kafka"])).toThrow('Unknown transport "kafka"');
  expect(() => parseMicroservices("Orders!")).toThrow("isn't a service name");
  expect(() => parseMicroservices("web")).toThrow("taken by the monorepo");
  expect(() => parseMicroservices("a,a")).toThrow("named twice");
});

test("a monorepo with two services: workspaces, turbo, shared types, and the app calling a service over TCP", async () => {
  mkdirSync(join(scratch, "node_modules", "@archlast"), { recursive: true });
  // What `bun install` would give the generated apps: the engine's packages, here from the workspace.
  symlinkSync(join(import.meta.dir, "../../runtime"), join(scratch, "node_modules", "@archlast", "forge-runtime"), "dir");
  const root = scaffoldMonorepo({ dir: join(scratch, "acme"), mode: "backend", services: [], microservices: ["orders", "billing"], transport: "tcp" });

  const pkg = JSON.parse(read(root, "package.json"));
  expect(pkg).toMatchObject({ name: "acme", workspaces: ["apps/*", "packages/*"], scripts: { dev: "turbo run dev", typecheck: "turbo run typecheck" }, devDependencies: { turbo: expect.any(String) } });
  expect(JSON.parse(read(root, "turbo.json")).tasks.dev).toEqual({ cache: false, persistent: true });
  for (const app of ["api", "orders", "billing"]) expect(existsSync(join(root, "apps", app, "forge", "schema.ts")), app).toBe(true);
  expect(JSON.parse(read(root, "apps", "orders", "package.json"))).toMatchObject({ name: "@acme/orders", scripts: { dev: "archlast-forge dev --no-docker --port 3001" } });
  expect(read(root, "packages", "api", "index.ts")).toContain('export { api as ordersApi } from "../../apps/orders/forge/_generated/api";');
  expect(read(root, "apps", "billing", "forge", "http.ts")).toContain("port: Number(process.env.BILLING_PORT ?? 4002)");
  expect(read(root, "README.md")).toContain("Services calling services");
  const check = Bun.spawnSync([process.execPath, require.resolve("prettier/bin/prettier.cjs"), "--check", "."], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(check.exitCode).toBe(0);

  // The generated example, run: orders listens on its TCP port; the main app's action sends it a message and returns its answer.
  for (const app of ["api", "orders"]) await codegen(join(root, "apps", app, "forge"));
  const tcp = await freePort();
  const env = (name: string) => ({ ...process.env, PORT: "0", DATA_DIR: join(scratch, `data-${name}`), ORDERS_PORT: String(tcp) });
  const orders = await startServer({ forgeDir: join(root, "apps", "orders", "forge"), dev: true, env: env("orders") });
  const api = await startServer({ forgeDir: join(root, "apps", "api", "forge"), dev: true, env: env("api") });
  try {
    const hello = async () => {
      const res = await fetch(`${api.url}/rpc/orders:hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "api" }) });
      return ((await res.json()) as { result?: unknown; error?: unknown });
    };
    let first = await hello();
    for (let i = 0; i < 50 && !first.result; i++) (await Bun.sleep(200), (first = await hello())); // the service's listener starts with its runtime
    expect(first).toEqual({ result: { service: "orders", greeting: "Hello, api", calls: 1 } });
    expect((await hello()).result).toMatchObject({ calls: 2 }); // orders recorded each call in its own database
  } finally {
    await api.stop({ graceful: false });
    await orders.stop({ graceful: false });
  }
});
