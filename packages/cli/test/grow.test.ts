import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scaffold } from "create-archlast-forge";

setDefaultTimeout(300_000); // each command is a process, and the scaffolds run Prettier

const CLI = join(import.meta.dir, "../src/index.ts");
const scratch = join(import.meta.dir, ".tmp-grow");
mkdirSync(scratch, { recursive: true });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const json = (...p: string[]) => JSON.parse(read(...p));

/** The CLI as a user runs it: from a folder, with no terminal (so nothing can be asked). */
async function cli(args: string[], cwd: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

test("help lists the commands that change a project", async () => {
  const { out } = await cli(["--help"], scratch);
  for (const line of [
    "monorepo ",
    "add service <name>",
    "add app <name>",
    "add mobile",
    "add desktop <full|client>",
    "remove <name>",
    "workspace [sync]",
    "stack [add|remove <list>]",
    "--no-install",
  ])
    expect(out).toContain(line);
});

test("monorepo: a plan first, a question before moving anything, then the project is the main app of one", async () => {
  const dir = join(scratch, "blog");
  scaffold({ dir, mode: "backend", services: ["postgres"] });

  let r = await cli(["add", "service", "orders", "--no-install"], dir);
  expect(r.code).toBe(1);
  expect(r.err).toContain("isn't in a monorepo");
  expect(r.err).toContain("archlast-forge monorepo");

  r = await cli(["monorepo", "--dry-run", "--microservices", "orders"], dir);
  expect(r.code).toBe(0);
  expect(r.out).toContain("move to apps/api");
  expect(r.out).toContain("apps/orders: the orders service");
  expect(r.out).toContain("Dry run: nothing was changed");
  expect(existsSync(join(dir, "forge"))).toBe(true);

  r = await cli(["monorepo", "--no-install"], dir); // no --yes, and no terminal to ask on
  expect(r.code).toBe(1);
  expect(r.err).toContain("--yes");
  expect(existsSync(join(dir, "forge"))).toBe(true);

  r = await cli(["monorepo", "--yes", "--no-install", "--microservices", "orders", "--transport", "tcp"], dir);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain("bun run dev");
  expect(existsSync(join(dir, "forge"))).toBe(false);
  expect(existsSync(join(dir, "apps", "api", "forge", "schema.ts"))).toBe(true);
  expect(json(dir, "archlast-forge.workspace.json")).toMatchObject({ main: "api", transport: "tcp", apps: { orders: { kind: "service", port: 3001 } } });

  // From inside one of its apps: it is already a monorepo.
  r = await cli(["monorepo", "--yes"], join(dir, "apps", "api"));
  expect(r.code).toBe(1);
  expect(r.err).toContain("already part of the monorepo");
  r = await cli(["monorepo"], dir);
  expect(r.code).toBe(1);
  expect(r.err).toContain("already a monorepo");

  // The rest of the commands, from wherever in the monorepo you are.
  r = await cli(["add", "service", "billing", "--no-install"], join(dir, "apps", "api", "forge"));
  expect(r.err).toBe("");
  expect(r.out).toContain("apps/billing: the billing service");
  r = await cli(["add", "app", "jobs", "--mode", "backend", "--services", "postgres", "--no-install"], dir);
  expect(r.out).toContain("apps/jobs: a backend, dev on 3003");
  expect(json(dir, "apps", "jobs", "archlast-forge.json")).toEqual({ mode: "backend", services: ["postgres"] });

  r = await cli(["workspace"], join(dir, "apps", "orders"));
  expect(r.code).toBe(0);
  for (const line of ["apps/api", "main app, backend", "apps/orders", "service, TCP on 4001", "apps/billing", "apps/jobs", "http://localhost:3003"]) expect(r.out).toContain(line);

  r = await cli(["remove", "billing", "--no-install"], dir);
  expect(r.code).toBe(1);
  expect(r.err).toContain("--yes");
  expect(existsSync(join(dir, "apps", "billing"))).toBe(true);
  r = await cli(["remove", "billing", "--yes", "--no-install"], dir);
  expect(r.code).toBe(0);
  expect(existsSync(join(dir, "apps", "billing"))).toBe(false);
  expect(read(dir, "apps", "api", "forge", "_services.ts")).not.toContain("Billing");
  r = await cli(["remove", "nope", "--yes"], dir);
  expect(r.code).toBe(1);
  expect(r.err).toContain("There is no apps/nope");

  r = await cli(["workspace", "sync", "--no-install"], dir);
  expect(r.code).toBe(0);
  expect(r.out).toContain("packages/api");
});

test("stack: shows the services, changes them in the app you are in, and says where it can't", async () => {
  const root = join(scratch, "shop");
  scaffold({ dir: join(root, "apps", "web"), mode: "backend", services: ["postgres"] });

  let r = await cli(["stack"], join(root, "apps", "web"));
  expect(r.out).toContain("postgres");
  expect(r.out).toContain("available: postgres, redis, s3, caddy");
  r = await cli(["stack", "add", "redis,s3"], join(root, "apps", "web"));
  expect(r.err).toBe("");
  expect(r.out).toContain("archlast-forge.json: postgres, redis, s3");
  expect(json(root, "apps", "web", "archlast-forge.json").services).toEqual(["postgres", "redis", "s3"]);
  expect(read(root, "apps", "web", "compose.yaml")).toContain("redis:");
  r = await cli(["stack", "remove", "postgres"], join(root, "apps", "web"));
  expect(read(root, "apps", "web", "compose.yaml")).not.toContain("postgres:");
  expect(r.out).toContain("Documents in the old database are not moved");
  r = await cli(["stack", "add", "mongo"], join(root, "apps", "web"));
  expect(r.code).toBe(1);
  expect(r.err).toContain('Unknown service "mongo"');
  r = await cli(["stack", "add", "redis"], join(root, "apps", "web"));
  expect(r.err).toContain("Nothing to change");
});

test("bad input is a line saying what to change", async () => {
  const dir = join(scratch, "inputs");
  scaffold({ dir, mode: "backend", services: [] });
  const wrong: [string[], string][] = [
    [["add"], "Usage: archlast-forge add service"],
    [["monorepo", "--transport", "kafka", "--dry-run"], 'Unknown transport "kafka"'],
    [["monorepo", "--desktop", "web", "--dry-run"], 'Unknown desktop mode "web"'],
    [["monorepo", "--mobile", "--microservices", "web", "--dry-run"], "taken by the monorepo"],
    [["remove"], "Usage: archlast-forge remove"],
  ];
  for (const [args, message] of wrong) {
    const r = await cli(args, dir);
    expect(r.code, args.join(" ")).toBe(1);
    expect(r.err, args.join(" ")).toContain(message);
  }
});
