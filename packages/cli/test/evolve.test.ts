import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scaffold, scaffoldMonorepo } from "create-archlast-forge";
import { loadWorkspace, WORKSPACE_FILE } from "create-archlast-forge/workspace";
import { startServer } from "../../runtime/src/server/server";
import { codegen } from "../src/codegen";
import { addApp, addDesktopTo, addMobileTo, addService, convertToMonorepo, removeApp, syncWorkspace } from "../src/evolve";
import { changeStack } from "../src/stack-edit";

setDefaultTimeout(120_000); // scaffolds run Prettier, and the services start for real

// Inside the repository, so generated code finds the workspace's packages as an installed project would.
const scratch = join(import.meta.dir, ".tmp-evolve");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const json = (...p: string[]) => JSON.parse(read(...p));
const fresh = (name: string) => join(scratch, name);
const freePort = async () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  await s.stop(true);
  return port;
};
const prettierCheck = (cwd: string, ...files: string[]) =>
  Bun.spawnSync([process.execPath, require.resolve("prettier/bin/prettier.cjs"), "--check", ...files], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode;

// What `bun install` would give the generated apps: the engine's packages, here from the workspace.
mkdirSync(join(scratch, "node_modules", "@archlast"), { recursive: true });
symlinkSync(join(import.meta.dir, "../../runtime"), join(scratch, "node_modules", "@archlast", "forge-runtime"), "dir");
mkdirSync(join(scratch, "node_modules", "@blog"), { recursive: true });

test("convert: a full-stack app becomes the main app of a monorepo, keeping everything it had, and its code is not reformatted", async () => {
  const dir = fresh("blog");
  scaffold({ dir, mode: "framework", services: ["postgres"] });
  // What the user has: a function in their own style, a secret, CI, a repository, and installed packages.
  writeFileSync(join(dir, "forge", "mine.ts"), `export const x = {a:1,\n  b:2}\n`);
  writeFileSync(join(dir, ".env"), "ADMIN_KEY=keep-me\n");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  const composeBefore = read(dir, "compose.yaml");

  const plan = convertToMonorepo({ dir, microservices: ["orders"], dryRun: true });
  expect(plan.moves).toContain("forge");
  expect(plan.moves).not.toContain(".git");
  expect(existsSync(join(dir, "apps"))).toBe(false); // a dry run changes nothing

  const change = convertToMonorepo({ dir, microservices: ["orders"] });
  expect(change.apps).toEqual(["web", "orders"]);
  // Moved, byte for byte.
  expect(read(dir, "apps", "web", "forge", "mine.ts")).toBe(`export const x = {a:1,\n  b:2}\n`);
  expect(read(dir, "apps", "web", ".env")).toStartWith("ADMIN_KEY=keep-me\n");
  expect(read(dir, "apps", "web", "compose.yaml")).toBe(composeBefore); // its project name, so its Docker volumes, are the same
  expect(read(dir, "apps", "web", "compose.yaml")).toContain("name: blog\n");
  expect(existsSync(join(dir, "forge"))).toBe(false);
  // The repository's own files stayed.
  expect(read(dir, ".github", "workflows", "ci.yml")).toBe("name: ci\n");
  expect(read(dir, ".git", "HEAD")).toBe("ref: refs/heads/main\n");
  expect(existsSync(join(dir, "node_modules", "left-pad"))).toBe(true);
  // The monorepo around it.
  expect(json(dir, "package.json")).toMatchObject({ name: "blog", workspaces: ["apps/*", "packages/*"], scripts: { dev: "turbo run dev" } });
  expect(json(dir, "apps", "web", "package.json").name).toBe("@blog/web");
  expect(json(dir, WORKSPACE_FILE)).toEqual({ main: "web", transport: "forge-rpc", apps: { orders: { kind: "service", port: 3001, rpcPort: 4001 } } });
  expect(read(dir, "packages", "api", "index.ts")).toContain('export { api as webApi } from "../../apps/web/forge/_generated/api";');
  expect(read(dir, "packages", "api", "index.ts")).not.toContain("ordersApi"); // a service is called over Forge RPC, and its schema can't share a project with the main app's
  expect(read(dir, "apps", "web", "forge", "_services.ts")).toContain("serviceControllers = [OrdersController]");
  expect(read(dir, "apps", "web", "forge", "http.ts")).toContain("controllers: serviceControllers"); // a full-stack app had no http.ts: it has one now
  expect(read(dir, "apps", "orders", "compose.yaml")).toContain("name: blog-orders\n"); // unique among monorepos on one machine
  const token = /^FORGE_RPC_TOKEN=(\w+)$/m.exec(read(dir, "apps", "web", ".env"))![1];
  expect(/^FORGE_RPC_TOKEN=(\w+)$/m.exec(read(dir, "apps", "orders", ".env"))![1]).toBe(token);
  expect(change.notes.join("\n")).toContain("bun install");
  expect(change.notes.join("\n")).toContain(".github stays at the root");
  expect(prettierCheck(dir, "packages", "apps/orders", "apps/web/forge/_services.ts", "package.json")).toBe(0); // what it wrote is formatted

  // And it runs: the main app's action reaches the service that was added in the same step.
  symlinkSync(join(dir, "packages", "contracts"), join(scratch, "node_modules", "@blog", "contracts"), "dir");
  for (const app of ["web", "orders"]) await codegen(join(dir, "apps", app, "forge"));
  const port = await freePort();
  const env = (n: string) => ({
    ...process.env,
    PORT: "0",
    DATA_DIR: join(scratch, `data-${n}`),
    ORDERS_RPC_PORT: String(port),
    ORDERS_RPC_URL: `http://127.0.0.1:${port}`,
    FORGE_RPC_TOKEN: token,
  });
  const orders = await startServer({ forgeDir: join(dir, "apps", "orders", "forge"), dev: true, env: env("orders") });
  const web = await startServer({ forgeDir: join(dir, "apps", "web", "forge"), dev: true, env: env("web") });
  try {
    const call = async (path: string) =>
      (await (await fetch(`${web.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "web" }) })).json()) as any;
    let first = await call("/rpc/orders:hello");
    for (let i = 0; i < 50 && !first.result; i++) (await Bun.sleep(200), (first = await call("/rpc/orders:hello")));
    expect(first).toEqual({ result: { service: "orders", greeting: "Hello, web", calls: 1 } });
    expect(await call("/http/orders/hello")).toEqual({ service: "orders", greeting: "Hello, web", calls: 2 });
  } finally {
    await web.stop({ graceful: false });
    await orders.stop({ graceful: false });
  }
});

test("convert refuses what it can't do safely, and a backend's main app runs on this machine once it has services", () => {
  const mono = fresh("already");
  scaffoldMonorepo({ dir: mono, mode: "backend", services: [], microservices: [] });
  expect(() => convertToMonorepo({ dir: mono })).toThrow("is a monorepo already");
  const empty = fresh("empty");
  mkdirSync(empty, { recursive: true });
  expect(() => convertToMonorepo({ dir: empty })).toThrow("No forge/");
  const taken = fresh("taken");
  scaffold({ dir: taken, mode: "backend", services: [] });
  mkdirSync(join(taken, "apps"));
  expect(() => convertToMonorepo({ dir: taken })).toThrow("exists already");
  const web = fresh("webapp");
  scaffold({ dir: web, mode: "framework", services: [] });
  expect(() => convertToMonorepo({ dir: web, microservices: ["web"] })).toThrow("taken by the monorepo");
  expect(existsSync(join(web, "forge"))).toBe(true); // nothing moved

  const back = fresh("backend");
  scaffold({ dir: back, mode: "backend", services: [] });
  convertToMonorepo({ dir: back });
  expect(json(back, "apps", "api", "package.json").scripts.dev).toBe("archlast-forge dev"); // no services: Docker is fine
  addService(back, "orders");
  expect(json(back, "apps", "api", "package.json").scripts.dev).toBe("archlast-forge dev --no-docker"); // its code reaches the service's port
});

test("add service, again and again: ports, the list the main app mounts, contracts and one token; remove undoes it", () => {
  const root = fresh("shop");
  scaffoldMonorepo({ dir: root, mode: "backend", services: [], microservices: [] });
  expect(existsSync(join(root, "packages", "contracts"))).toBe(false); // no services yet

  addService(join(root, "apps", "api", "forge"), "orders"); // from inside the monorepo
  const second = addService(root, "user-billing");
  expect(second.apps).toEqual(["user-billing", "api"]);
  expect(json(root, WORKSPACE_FILE).apps).toEqual({ orders: { kind: "service", port: 3001, rpcPort: 4001 }, "user-billing": { kind: "service", port: 3002, rpcPort: 4002 } });
  expect(read(root, "apps", "user-billing", "forge", "http.ts")).toContain("USER_BILLING_RPC_PORT ?? 4002");
  expect(json(root, "apps", "user-billing", "package.json").scripts.dev).toBe("archlast-forge dev --no-docker --port 3002");
  expect(read(root, "apps", "api", "forge", "_services.ts")).toMatch(
    /serviceControllers = \[OrdersController, UserBillingController\];\s+export const serviceProviders = \[OrdersService, UserBillingService\];/,
  );
  expect(read(root, "apps", "api", "forge", "http.ts").match(/^nest\(/gm)).toHaveLength(1); // http.ts was edited once, by the first
  expect(read(root, "packages", "contracts", "index.ts")).toContain("UserBillingRpc");
  expect(json(root, "apps", "api", "package.json").devDependencies["@shop/contracts"]).toBe("workspace:*");
  const tokens = ["api", "orders", "user-billing"].map((a) => /^FORGE_RPC_TOKEN=(\w+)$/m.exec(read(root, "apps", a, ".env"))?.[1]);
  expect(new Set(tokens).size).toBe(1);

  expect(() => addService(root, "orders")).toThrow("already an app");
  expect(() => addService(root, "web")).toThrow("taken by the monorepo");
  writeFileSync(join(root, "apps", "api", "forge", "payments.ts"), "export {}\n");
  expect(() => addService(root, "payments")).toThrow("payments.ts already exists");
  expect(existsSync(join(root, "apps", "payments"))).toBe(false); // refused before writing anything

  const removed = removeApp(root, "orders");
  expect(removed.summary).toContain("apps/api/forge/orders.service.ts: deleted");
  expect(existsSync(join(root, "apps", "orders"))).toBe(false);
  expect(existsSync(join(root, "apps", "api", "forge", "orders.ts"))).toBe(false);
  expect(read(root, "apps", "api", "forge", "_services.ts")).toContain("serviceControllers = [UserBillingController]");
  expect(read(root, "packages", "contracts", "index.ts")).not.toContain("Rpc as OrdersRpc");
  removeApp(root, "user-billing");
  expect(read(root, "apps", "api", "forge", "_services.ts")).toContain("serviceControllers: never[] = []"); // http.ts still imports it
  expect(existsSync(join(root, "packages", "contracts"))).toBe(false); // nothing left to share
  expect(json(root, "apps", "api", "package.json").devDependencies?.["@shop/contracts"]).toBeUndefined();
  expect(() => removeApp(root, "api")).toThrow("main app");
  expect(() => removeApp(root, "nope")).toThrow('no app or service named "nope"');
  expect(prettierCheck(root, "apps/api/forge/_services.ts", "packages")).toBe(0);
});

test("add service with TCP or Redis: the client package, and no contracts", () => {
  const root = fresh("tcpredis");
  scaffoldMonorepo({ dir: root, mode: "backend", services: [], microservices: ["orders"], transport: "redis" });
  addService(root, "billing");
  expect(json(root, WORKSPACE_FILE).transport).toBe("redis");
  expect(read(root, "apps", "billing", "forge", "billing.controller.ts")).toContain('@MessagePattern("billing.hello")');
  for (const app of ["api", "orders", "billing"]) expect(json(root, "apps", app, "forge", "package.json").dependencies.ioredis).toBeDefined();
  expect(existsSync(join(root, "packages", "contracts"))).toBe(false);
});

test("add app: another full-stack app or a backend, on its own port, with its types in packages/api", () => {
  const root = fresh("apps");
  scaffoldMonorepo({ dir: root, mode: "framework", services: [], microservices: ["orders"] });
  const change = addApp(root, "admin");
  expect(change.apps).toEqual(["admin"]);
  expect(existsSync(join(root, "apps", "admin", "app", "routes"))).toBe(true); // a full-stack app
  expect(json(root, "apps", "admin", "package.json")).toMatchObject({ name: "@apps/admin", scripts: { dev: "archlast-forge dev --no-docker --port 3002" } });
  expect(json(root, "apps", "admin", "archlast-forge.json")).toEqual({ mode: "framework", services: ["postgres", "redis", "s3", "caddy"] });
  expect(read(root, "apps", "admin", "compose.yaml")).toContain("name: apps-admin\n");
  expect(read(root, "packages", "api", "admin.ts")).toContain('export { api as adminApi } from "../../apps/admin/forge/_generated/api";'); // each other app in a file of its own
  expect(json(root, "packages", "api", "package.json").exports).toMatchObject({ ".": "./index.ts", "./admin": "./admin.ts" });
  expect(read(root, "packages", "api", "index.ts")).not.toContain("adminApi");
  expect(/^FORGE_RPC_TOKEN=/m.test(read(root, "apps", "admin", ".env"))).toBe(true); // it can call the services too
  addApp(root, "jobs", { mode: "backend", services: ["postgres"] });
  expect(json(root, "apps", "jobs", "archlast-forge.json")).toEqual({ mode: "backend", services: ["postgres"] });
  expect(json(root, WORKSPACE_FILE).apps).toMatchObject({ orders: { kind: "service", port: 3001 }, admin: { kind: "app", port: 3002 }, jobs: { kind: "app", port: 3003 } });
  addService(root, "billing"); // a service after the apps: the next free ports, not a clash
  expect(json(root, WORKSPACE_FILE).apps.billing).toEqual({ kind: "service", port: 3004, rpcPort: 4002 });
  expect(() => addApp(root, "admin")).toThrow("already an app");

  const gone = removeApp(root, "admin");
  expect(gone.summary).toEqual(["apps/admin: deleted"]);
  expect(existsSync(join(root, "packages", "api", "admin.ts"))).toBe(false); // its file in packages/api goes with it
  expect(json(root, "packages", "api", "package.json").exports).toEqual({ ".": "./index.ts", "./jobs": "./jobs.ts" });
  expect(json(root, WORKSPACE_FILE).apps.admin).toBeUndefined();
});

test("add mobile and desktop: only where they fit, and a backend's own auth.ts is left alone", () => {
  const web = fresh("fullstack");
  scaffoldMonorepo({ dir: web, mode: "framework", services: [] });
  const phone = addMobileTo(web); // a client of the full-stack app: it serves the same API and sign-in as a backend does
  expect(phone.apps).toEqual(["web"]);
  expect(read(web, "apps", "mobile", "src", "client.ts")).toContain('import type { webApi } from "@fullstack/api";');
  expect(read(web, "apps", "web", "forge", "auth.ts")).toContain("plugins: [expo()]");
  addDesktopTo(web, "full");
  expect(existsSync(join(web, "apps", "desktop", "engine", "desktop-engine.ts"))).toBe(true);
  expect(json(web, WORKSPACE_FILE).desktop).toBe("full");
  expect(() => addDesktopTo(web, "client")).toThrow("already exists");

  const api = fresh("phone");
  scaffoldMonorepo({ dir: api, mode: "backend", services: [] });
  expect(() => addDesktopTo(api, "full")).toThrow("use `add desktop client`");
  writeFileSync(join(api, "apps", "api", "forge", "auth.ts"), "export default {} // mine\n");
  const change = addMobileTo(api);
  expect(read(api, "apps", "api", "forge", "auth.ts")).toBe("export default {} // mine\n"); // not overwritten
  expect(change.notes.join("\n")).toContain("plugins: [expo()]");
  expect(json(api, "apps", "mobile", "package.json").name).toBe("@phone/mobile");
  expect(json(api, WORKSPACE_FILE).mobile).toBe(true);
  removeApp(api, "mobile");
  expect(existsSync(join(api, "apps", "mobile"))).toBe(false);
  expect(json(api, WORKSPACE_FILE).mobile).toBeUndefined();
});

test("a monorepo without the workspace file (made before it) is worked out from its folders; sync catches up with hand-made changes", () => {
  const root = fresh("older");
  scaffoldMonorepo({ dir: root, mode: "framework", services: [], microservices: ["orders", "billing"], transport: "tcp" });
  const written = loadWorkspace(root);
  expect(written.inferred).toBe(false);
  rmSync(join(root, WORKSPACE_FILE));
  const inferred = loadWorkspace(root);
  expect(inferred.inferred).toBe(true);
  expect(inferred.ws).toEqual(written.ws); // main, transport, kinds and ports
  expect(inferred.name).toBe("older");
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify(inferred.ws)); // what the first change would write

  // An app made by hand, and a service folder deleted by hand.
  scaffold({ dir: join(root, "apps", "extra"), mode: "backend", services: [], name: "older-extra" });
  rmSync(join(root, "apps", "billing"), { recursive: true });
  const sync = syncWorkspace(root);
  expect(sync.summary.join("\n")).toContain("billing: its folder is gone");
  expect(sync.summary.join("\n")).toContain("extra: found in apps/");
  expect(sync.notes.join("\n")).toContain("billing.service.ts");
  expect(json(root, WORKSPACE_FILE).apps).toEqual({ orders: { kind: "service", port: 3001, rpcPort: 4001 }, extra: { kind: "app", port: 3002 } }); // billing's freed port
  expect(read(root, "packages", "api", "extra.ts")).toContain("extraApi");
  expect(existsSync(join(root, "packages", "api", "billing.ts"))).toBe(false);

  expect(() => addService(fresh("nowhere"), "x")).toThrow("isn't in a monorepo");
});

test("stack: services are added and removed in archlast-forge.json, compose.yaml, .env and the Caddyfile; edits of yours are kept", () => {
  const a = join(scratch, "a", "app");
  const b = join(scratch, "b", "app");
  scaffold({ dir: a, mode: "backend", services: ["postgres"] });
  scaffold({ dir: b, mode: "backend", services: ["postgres", "redis", "s3", "caddy"] });
  const env = read(a, ".env");
  const change = changeStack(a, { add: ["redis", "s3", "caddy"] });
  expect(change.services).toEqual(["postgres", "redis", "s3", "caddy"]);
  expect(json(a, "archlast-forge.json")).toEqual({ mode: "backend", services: ["postgres", "redis", "s3", "caddy"] });
  expect(read(a, "compose.yaml")).toBe(read(b, "compose.yaml")); // what a project that began with them has
  expect(read(a, "Caddyfile")).toBe(read(b, "Caddyfile"));
  expect(read(a, ".env.example")).toBe(read(b, ".env.example"));
  expect(read(a, ".env").startsWith(env)).toBe(true); // nothing it had was touched
  expect(read(a, ".env")).toMatch(/S3_ACCESS_KEY=forge\w+/);
  expect(read(a, ".env")).toContain("DOMAIN=localhost");
  expect(change.notes.join("\n")).toContain("BETTER_AUTH_URL=https://<your domain>");

  changeStack(a, { remove: ["caddy", "postgres"] });
  expect(existsSync(join(a, "Caddyfile"))).toBe(false);
  expect(read(a, "compose.yaml")).not.toContain("postgres:");
  expect(read(a, "compose.yaml")).toContain("redis:");
  expect(() => changeStack(a, { add: ["redis"] })).toThrow("Nothing to change");
  expect(() => changeStack(a, { add: ["mongo" as never] })).toThrow('Unknown service "mongo"');

  // A compose.yaml with a change of the user's is not overwritten.
  const mine = read(a, "compose.yaml").replace("restart: unless-stopped", "restart: always");
  writeFileSync(join(a, "compose.yaml"), mine);
  const kept = changeStack(a, { add: ["postgres"] });
  expect(read(a, "compose.yaml")).toBe(mine);
  expect(read(a, "compose.new.yaml")).toContain("postgres:");
  expect(kept.notes.join("\n")).toContain("compose.new.yaml");
  expect(() => changeStack(join(scratch, "nope"), { add: ["redis"] })).toThrow("No archlast-forge.json");
});

/** The names of every workspace package of a monorepo: what `bun install` needs to be unique. */
const packageNames = (root: string) =>
  ["apps", "packages"]
    .flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)) : []).map((p) => join(root, d, p, "package.json")).filter(existsSync))
    .map((f) => JSON.parse(readFileSync(f, "utf8")).name as string);

test("package names are unique: a backend main app is @<name>/backend, since packages/api is @<name>/api; sync repairs an older monorepo", () => {
  const made = fresh("names");
  scaffoldMonorepo({ dir: made, mode: "backend", services: [], microservices: ["orders"], mobile: true });
  addApp(made, "jobs", { mode: "backend", services: [] });
  addService(made, "billing");
  const names = packageNames(made);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toContain("@names/backend");
  expect(json(made, "packages", "api", "package.json").devDependencies).toMatchObject({ "@names/backend": "workspace:*", "@names/jobs": "workspace:*" });
  expect(json(made, "packages", "api", "package.json").devDependencies["@names/api"]).toBeUndefined(); // it would depend on itself
  expect(json(made, "packages", "api", "package.json").devDependencies["@names/orders"]).toBeUndefined(); // services are not in it

  const converted = fresh("names2");
  scaffold({ dir: converted, mode: "backend", services: [] });
  convertToMonorepo({ dir: converted, microservices: ["orders"] });
  expect(new Set(packageNames(converted)).size).toBe(packageNames(converted).length);

  // A monorepo made while the names clashed.
  const patch = JSON.parse(read(made, "apps", "api", "package.json"));
  writeFileSync(join(made, "apps", "api", "package.json"), JSON.stringify({ ...patch, name: "@names/api" }, null, 4) + "\n");
  expect(new Set(packageNames(made)).size).not.toBe(packageNames(made).length);
  const fixed = syncWorkspace(made);
  expect(fixed.summary.join("\n")).toContain("renamed to @names/backend");
  expect(json(made, "apps", "api", "package.json").name).toBe("@names/backend");
  expect(new Set(packageNames(made)).size).toBe(packageNames(made).length);
});

test("a monorepo made by hand is adopted: its main app and its package scope have their own names, and packages/api, mobile and desktop follow", () => {
  // What a hand-made monorepo looks like: a root of its own, a full-stack app that isn't called web, and a shared package.
  const make = (name: string) => {
    const root = fresh(name);
    mkdirSync(join(root, "packages", "shared"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: `archlast-${name}`, private: true, workspaces: ["apps/*", "packages/*"] }, null, 2));
    writeFileSync(join(root, "turbo.json"), "{}\n");
    scaffold({ dir: join(root, "apps", "ward"), mode: "framework", services: [], name });
    const file = join(root, "apps", "ward", "package.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), name: "@hospital/app" }, null, 4));
    return root;
  };
  const root = make("handmade");

  // Without the file, the only app is the main app; with two and no web or api, it can't be told, and the message says how.
  expect(loadWorkspace(root)).toMatchObject({ inferred: true, name: "archlast-handmade", ws: { main: "ward", transport: "forge-rpc", apps: {} } });
  scaffold({ dir: join(root, "apps", "clinic"), mode: "backend", services: [], name: "clinic" });
  expect(() => loadWorkspace(root)).toThrow('Can\'t tell which of clinic, ward is the main app: say so with "main"');
  rmSync(join(root, "apps", "clinic"), { recursive: true });
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify({ main: "nope", transport: "forge-rpc", apps: {} }));
  expect(() => loadWorkspace(root)).toThrow("there is no apps/nope");
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify({ main: "ward", scope: "hospital", transport: "forge-rpc", apps: {} }));
  expect(loadWorkspace(root)).toMatchObject({ inferred: false, name: "hospital", ws: { main: "ward", scope: "hospital" } });

  // sync writes packages/api for it: the scope is the file's, and the app's package is the one its package.json names.
  syncWorkspace(root);
  expect(read(root, "packages", "api", "index.ts")).toContain('export { api as wardApi } from "../../apps/ward/forge/_generated/api";');
  expect(json(root, "packages", "api", "package.json")).toMatchObject({ name: "@hospital/api", devDependencies: { "@hospital/app": "workspace:*" } });
  expect(json(root, WORKSPACE_FILE).scope).toBe("hospital"); // kept when the file is written again

  // A phone app and a desktop app for it: named for the scope, typed from the main app, which gets the Expo plugin.
  addMobileTo(root);
  expect(json(root, "apps", "mobile", "package.json")).toMatchObject({ name: "@hospital/mobile", dependencies: { "@hospital/api": "workspace:*" } });
  expect(read(root, "apps", "mobile", "src", "client.ts")).toContain('import type { wardApi } from "@hospital/api";');
  expect(read(root, "apps", "mobile", "src", "client.ts")).toMatch(/scheme: "hospital",\s+storagePrefix: "hospital"/);
  expect(json(root, "apps", "mobile", "app.json").expo).toMatchObject({ scheme: "hospital" });
  expect(read(root, "apps", "ward", "forge", "auth.ts")).toContain('trustedOrigins: ["hospital://"]');
  addDesktopTo(root, "client");
  expect(json(root, "apps", "desktop", "package.json")).toMatchObject({ name: "@hospital/desktop", dependencies: { "@hospital/api": "workspace:*" } });
  expect(read(root, "apps", "desktop", "src", "main.tsx")).toContain('import type { wardApi } from "@hospital/api";');
  expect(json(root, WORKSPACE_FILE)).toMatchObject({ main: "ward", scope: "hospital", mobile: true, desktop: "client" });

  // The full desktop app bundles the main app by its own name, not apps/web.
  const other = make("handmade2");
  writeFileSync(join(other, WORKSPACE_FILE), JSON.stringify({ main: "ward", transport: "forge-rpc", apps: {} }));
  addDesktopTo(other, "full");
  expect(read(other, "apps", "desktop", "scripts", "bundle-engine.ts")).toContain('join(here, "..", "ward")');
  expect(() => addDesktopTo(fresh("backendmain"), "full")).toThrow("isn't in a monorepo");
});
