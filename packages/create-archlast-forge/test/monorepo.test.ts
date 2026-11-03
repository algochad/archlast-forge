import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { codegen } from "../../cli/src/codegen";
import { startServer } from "../../runtime/src/server/server";
import { parseFlags } from "../src/options";
import { parseMicroservices, scaffoldMonorepo } from "../src/monorepo";
import { copyFileSync, cpSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";

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
  expect(parseFlags(["x", "--transport", "forge-rpc"])).toMatchObject({ monorepo: true, transport: "forge-rpc" });
  expect(() => parseMicroservices("Orders!")).toThrow("isn't a name for a service or an app");
  expect(() => parseMicroservices("web")).toThrow("taken by the monorepo");
  expect(() => parseMicroservices("a,a")).toThrow("named twice");
  expect(parseFlags(["x", "--mode", "backend", "--mobile"])).toMatchObject({ monorepo: true, mobile: true });
  expect(parseFlags(["x", "--mode", "framework", "--mobile"])).toMatchObject({ mode: "framework", mobile: true, monorepo: true }); // a phone app is a client of a full-stack app too
});

test("--mobile: an Expo app in apps/mobile, a client of the backend, which gets Better Auth's Expo plugin", () => {
  mkdirSync(scratch, { recursive: true });
  const root = scaffoldMonorepo({ dir: join(scratch, "phone"), mode: "backend", services: [], mobile: true });
  const app = (...p: string[]) => read(root, "apps", "mobile", ...p);
  expect(JSON.parse(app("package.json"))).toMatchObject({ name: "@phone/mobile", scripts: { dev: "expo start" }, dependencies: { "@phone/api": "workspace:*", "expo-secure-store": expect.any(String), "@better-auth/expo": "1.7.12" } });
  expect(JSON.parse(app("app.json")).expo).toMatchObject({ scheme: "phone", slug: "phone" });
  expect(app("src", "client.ts")).toContain("process.env.EXPO_PUBLIC_API_URL");
  expect(app("src", "client.ts")).toContain('import type { apiApi } from "@phone/api";'); // types only: the backend's code is never bundled
  expect(app("src", "client.ts")).toContain("client.reconnect()"); // back from the background
  expect(app(".env")).toContain("EXPO_PUBLIC_API_URL=http://localhost:3000");
  expect(app(".gitignore")).toContain(".env");
  expect(app("README.md")).toContain("there is no full-stack Expo option");
  expect(read(root, "apps", "api", "forge", "auth.ts")).toMatch(/plugins: \[expo\(\)\],\s+trustedOrigins: \["phone:\/\/"\]/); // as Prettier wrapped it
  expect(JSON.parse(read(root, "apps", "api", "forge", "package.json")).dependencies["@better-auth/expo"]).toBe("1.7.12");
  for (const f of ["App.tsx", "index.ts", "metro.config.js", "tsconfig.json"]) expect(existsSync(join(root, "apps", "mobile", f)), f).toBe(true);
  const check = Bun.spawnSync([process.execPath, require.resolve("prettier/bin/prettier.cjs"), "--check", "."], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(check.exitCode).toBe(0);
  // The same for a full-stack main app: apps/mobile is a client of apps/web, and it is apps/web that gets the Expo plugin.
  const full = scaffoldMonorepo({ dir: join(scratch, "phoneweb"), mode: "framework", services: [], mobile: true });
  expect(read(full, "apps", "mobile", "src", "client.ts")).toContain('import type { webApi } from "@phoneweb/api";');
  expect(read(full, "apps", "mobile", "README.md")).toContain("a client of `apps/web`");
  expect(read(full, "apps", "web", "forge", "auth.ts")).toContain("plugins: [expo()]");
  expect(read(full, "packages", "api", "index.ts")).toContain('export { api as webApi } from "../../apps/web/forge/_generated/api";');
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
  // packages/api has the main app's types: services are called over a transport, and two backends' types can't share a TypeScript project.
  expect(read(root, "packages", "api", "index.ts")).toContain('export { api as apiApi } from "../../apps/api/forge/_generated/api";');
  expect(read(root, "packages", "api", "index.ts")).not.toContain("ordersApi");
  expect(JSON.parse(read(root, "packages", "api", "package.json")).devDependencies).toMatchObject({ "@acme/backend": "workspace:*", "@types/bun": expect.any(String) });
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

test("Forge RPC, the default: a router per service, its types generated and shared in packages/contracts, and the app calling it", async () => {
  mkdirSync(join(scratch, "node_modules", "@archlast"), { recursive: true });
  if (!existsSync(join(scratch, "node_modules", "@archlast", "forge-runtime"))) symlinkSync(join(import.meta.dir, "../../runtime"), join(scratch, "node_modules", "@archlast", "forge-runtime"), "dir");
  const root = scaffoldMonorepo({ dir: join(scratch, "shop"), mode: "backend", services: [], microservices: ["orders", "user-billing"] });
  const forge = (app: string, ...p: string[]) => read(root, "apps", app, "forge", ...p);
  expect(forge("orders", "orders.router.ts")).toContain('@Router({ alias: "orders" })');
  expect(forge("user-billing", "user-billing.router.ts")).toContain('@Router({ alias: "userBilling" })');
  expect(forge("orders", "http.ts")).toContain("process.env.ORDERS_RPC_PORT ?? 4001");
  // The main app calls each service from a class: a service class with the client, a controller over it, and an action reaching it.
  expect(forge("api", "orders.service.ts")).toContain('import type { OrdersRpc } from "@shop/contracts";');
  expect(forge("api", "orders.controller.ts")).toContain('@Controller("orders")');
  expect(forge("api", "orders.ts")).toContain("inject(ctx, OrdersService)");
  expect(forge("api", "_services.ts")).toMatch(/serviceControllers = \[OrdersController, UserBillingController\];\s+export const serviceProviders = \[OrdersService, UserBillingService\];/);
  expect(forge("api", "http.ts")).toMatch(/nest\(http, \{\s+controllers: serviceControllers,\s+providers: serviceProviders,?\s+\}\);/); // mounted once, through the list
  expect(read(root, "packages", "contracts", "index.ts")).toContain('export type { Rpc as UserBillingRpc } from "../../apps/user-billing/forge/_generated/rpc";');
  expect(JSON.parse(read(root, "apps", "api", "package.json")).devDependencies["@shop/contracts"]).toBe("workspace:*");
  const tokens = ["api", "orders", "user-billing"].map((app) => /^FORGE_RPC_TOKEN=(\w+)$/m.exec(read(root, "apps", app, ".env"))?.[1]);
  expect(new Set(tokens).size).toBe(1); // one secret the apps share
  expect(tokens[0]).toHaveLength(48);
  // One dashboard, the main app's: the services report there, and it lists them by the names they report under.
  const envOf = (app: string, key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(read(root, "apps", app, ".env"))?.[1];
  expect(envOf("api", "MICROSERVICES")).toBe("orders=http://localhost:3001,user-billing=http://localhost:3002");
  expect(["orders", "user-billing"].map((app) => [envOf(app, "OTEL_SERVICE_NAME"), envOf(app, "DASHBOARD_URL")])).toEqual([
    ["orders", "http://localhost:3000"],
    ["user-billing", "http://localhost:3000"],
  ]);
  expect(new Set(["api", "orders", "user-billing"].map((app) => envOf(app, "DASHBOARD_TOKEN"))).size).toBe(1);
  // Each app has a name of its own, which is also what keeps its Redis cache, topics and rate limits apart from the others' when they share a Redis.
  expect(["api", "orders", "user-billing"].map((app) => envOf(app, "OTEL_SERVICE_NAME"))).toEqual(["api", "orders", "user-billing"]);
  expect(envOf("api", "DASHBOARD_TOKEN")).toHaveLength(48);
  expect(Bun.spawnSync(["grep", "-rl", "@nestjs/", join(root, "apps")]).stdout.toString()).toBe(""); // the runtime's wrapping imports only
  expect(read(root, "README.md")).toContain("serves a Forge RPC router");
  expect(read(root, "README.md")).toContain("Forge RPC is backend to backend");
  expect(read(root, "packages", "contracts", "index.ts")).toContain("Backends only");
  expect(Bun.spawnSync([process.execPath, require.resolve("prettier/bin/prettier.cjs"), "--check", "."], { cwd: root }).exitCode).toBe(0);

  // Codegen writes each service's types from its router's schemas; the caller type-checks against them, and a wrong argument doesn't.
  for (const app of ["api", "orders", "user-billing"]) await codegen(join(root, "apps", app, "forge"));
  expect(forge("orders", "_generated", "rpc.ts")).toContain('hello: { kind: "mutation"; input: { from: string }; output: { service: string; greeting: string; calls: number } };');
  mkdirSync(join(scratch, "node_modules", "@shop"), { recursive: true });
  symlinkSync(join(root, "packages", "contracts"), join(scratch, "node_modules", "@shop", "contracts"), "dir"); // as the workspace install links it
  const typecheck = () => Bun.spawnSync([process.execPath, "check", "-p", join(root, "apps", "api", "forge")], { stdout: "pipe", stderr: "pipe" });
  expect(typecheck().exitCode).toBe(0);
  const caller = join(root, "apps", "api", "forge", "orders.service.ts");
  const source = read(caller);
  await Bun.write(caller, source.replace("hello.mutate({ from })", "hello.mutate({ from: 1 })"));
  expect(typecheck().stdout.toString()).toContain("orders.service.ts");
  await Bun.write(caller, source);

  // Run: orders serves its router on its port; the main app's action calls it with the shared token.
  const port = await freePort();
  const env = (name: string) => ({ ...process.env, PORT: "0", DATA_DIR: join(scratch, `data-rpc-${name}`), ORDERS_RPC_PORT: String(port), ORDERS_RPC_URL: `http://127.0.0.1:${port}`, FORGE_RPC_TOKEN: tokens[0] });
  const orders = await startServer({ forgeDir: join(root, "apps", "orders", "forge"), dev: true, env: env("orders") });
  const api = await startServer({ forgeDir: join(root, "apps", "api", "forge"), dev: true, env: env("api") });
  try {
    const hello = async () => (await (await fetch(`${api.url}/rpc/orders:hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "api" }) })).json()) as { result?: unknown };
    let first = await hello();
    for (let i = 0; i < 50 && !first.result; i++) (await Bun.sleep(200), (first = await hello())); // the service's listener starts with its runtime
    expect(first).toEqual({ result: { service: "orders", greeting: "Hello, api", calls: 1 } }); // the action, through OrdersService
    const http = await fetch(`${api.url}/http/orders/hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "api" }) });
    expect(await http.json()).toEqual({ service: "orders", greeting: "Hello, api", calls: 2 }); // the controller, through the same class
  } finally {
    await api.stop({ graceful: false });
    await orders.stop({ graceful: false });
  }
});

test("--desktop: flags and what they refuse", () => {
  expect(parseFlags(["x", "--desktop", "client"])).toMatchObject({ monorepo: true, desktop: "client" });
  expect(() => parseFlags(["x", "--desktop", "web"])).toThrow('Unknown desktop mode "web"');
  expect(() => parseFlags(["x", "--mode", "backend", "--desktop", "full"])).toThrow("use --mode framework");
});

test("--desktop full: Tauri with Bun as a sidecar that starts the full-stack app's engine; client: a page that talks to a backend", () => {
  mkdirSync(scratch, { recursive: true });
  const full = scaffoldMonorepo({ dir: join(scratch, "desk"), mode: "framework", services: [], desktop: "full" });
  const app = (...p: string[]) => read(full, "apps", "desktop", ...p);
  expect(app("src-tauri", "src", "main.rs")).toContain('.sidecar("bun")');
  const conf = JSON.parse(app("src-tauri", "tauri.conf.json"));
  expect(conf).toMatchObject({ productName: "desk", app: { windows: [] }, bundle: { externalBin: ["binaries/bun"], resources: { "app-bundle/": "app/" } }, build: { beforeBuildCommand: "bun scripts/bundle-engine.ts" } });
  expect(app("src-tauri", "Cargo.toml")).toContain("tauri-plugin-shell");
  expect(app("engine", "desktop-engine.ts")).toContain('HOST: "127.0.0.1"');
  expect(existsSync(join(full, "apps", "desktop", "index.html"))).toBe(false); // client mode's page isn't there
  const icon = new Uint8Array(readFileSync(join(full, "apps", "desktop", "src-tauri", "icons", "icon.png")));
  expect([...icon.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(new DataView(icon.buffer).getUint32(16)).toBe(512); // IHDR width
  expect(icon[25]).toBe(6); // RGBA, which Tauri needs
  expect(Bun.spawnSync([process.execPath, require.resolve("prettier/bin/prettier.cjs"), "--check", "."], { cwd: full }).exitCode).toBe(0);

  const client = scaffoldMonorepo({ dir: join(scratch, "deskc"), mode: "backend", services: [], desktop: "client" });
  const c = (...p: string[]) => read(client, "apps", "desktop", ...p);
  expect(c("src-tauri", "src", "main.rs")).not.toContain("sidecar");
  expect(JSON.parse(c("src-tauri", "tauri.conf.json"))).toMatchObject({ build: { devUrl: "http://localhost:5174", frontendDist: "../dist" }, app: { windows: [{ title: "deskc" }] } });
  expect(c("src", "main.tsx")).toContain('import type { apiApi } from "@deskc/api";');
  expect(JSON.parse(c("package.json"))).toMatchObject({ dependencies: { "@deskc/api": "workspace:*" }, devDependencies: { "@tauri-apps/cli": expect.any(String) } });
  expect(c("src-tauri", "Cargo.toml")).not.toContain("tauri-plugin-shell");
  expect(c("README.md")).toContain("TRUSTED_ORIGINS");
  expect(() => scaffoldMonorepo({ dir: join(scratch, "nope2"), mode: "backend", services: [], desktop: "full" })).toThrow("use --mode framework");
});

test("full mode's engine starter: production on 127.0.0.1 only, with its own secret in the data folder", async () => {
  // A bundle as scripts/bundle-engine.ts lays it out: the app's forge/, the starter, and the CLI where bun install puts it.
  mkdirSync(join(scratch, "node_modules", "@archlast"), { recursive: true });
  if (!existsSync(join(scratch, "node_modules", "@archlast", "forge-runtime"))) symlinkSync(join(import.meta.dir, "../../runtime"), join(scratch, "node_modules", "@archlast", "forge-runtime"), "dir");
  if (!existsSync(join(scratch, "node_modules", "@archlast", "forge-cli"))) symlinkSync(join(import.meta.dir, "../../cli"), join(scratch, "node_modules", "@archlast", "forge-cli"), "dir");
  const made = scaffoldMonorepo({ dir: join(scratch, "deskrun"), mode: "backend", services: [] });
  const bundle = join(scratch, "bundle");
  cpSync(join(made, "apps", "api", "forge"), join(bundle, "forge"), { recursive: true });
  copyFileSync(join(import.meta.dir, "../template/desktop/engine/desktop-engine.ts"), join(bundle, "desktop-engine.ts"));
  mkdirSync(join(bundle, "node_modules"), { recursive: true });
  symlinkSync(join(scratch, "node_modules", "@archlast"), join(bundle, "node_modules", "@archlast"), "dir");
  const port = await freePort();
  const data = join(scratch, "desk-data");
  const engine = Bun.spawn([process.execPath, join(bundle, "desktop-engine.ts")], { env: { ...process.env, PORT: String(port), DATA_DIR: data }, stdout: "ignore", stderr: "inherit" });
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      ready = await fetch(`http://127.0.0.1:${port}/ready`).then((r) => r.ok, () => false);
      if (!ready) await Bun.sleep(200);
    }
    expect(ready).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/rpc/messages:list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paginationOpts: { numItems: 5, cursor: null } }) });
    expect(((await res.json()) as any).result.page).toEqual([]);
    expect(statSync(join(data, "secret")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(data, "app.db"))).toBe(true); // the data folder Tauri gives it
    // Not on the network: an address of this machine other than the loopback doesn't answer.
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (lan) expect(await fetch(`http://${lan}:${port}/ready`).then(() => "answered", () => "refused")).toBe("refused");
  } finally {
    engine.kill("SIGTERM");
    await engine.exited;
  }
});
