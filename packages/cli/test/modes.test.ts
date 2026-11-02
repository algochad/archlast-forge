import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "create-archlast-forge";
import { checkFrontendImports } from "../src/codegen";
import { loadProjectConfig, projectRoot } from "../src/project";
import { ensureEnv } from "../src/stack";

const CLI = join(import.meta.dir, "../src/index.ts");
const fresh = (name = "app") => join(mkdtempSync(join(tmpdir(), "afx-modes-")), name);

/** The CLI as a user runs it. */
async function cli(args: string[], cwd?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

describe("project config", () => {
  test("is read from the folder around forge/", () => {
    const dir = fresh();
    scaffold({ dir, mode: "backend", services: ["postgres", "redis"] });
    expect(projectRoot(join(dir, "forge"))).toBe(dir);
    expect(loadProjectConfig(join(dir, "forge"))).toEqual({ mode: "backend", services: ["postgres", "redis"] });
  });

  test("a project from before it existed has none, and a broken one says where", () => {
    const old = fresh();
    mkdirSync(join(old, "forge"), { recursive: true });
    expect(loadProjectConfig(join(old, "forge"))).toBeUndefined();

    writeFileSync(join(old, "archlast-forge.json"), "{ nope");
    expect(() => loadProjectConfig(join(old, "forge"))).toThrow("archlast-forge.json isn't valid JSON");
    writeFileSync(join(old, "archlast-forge.json"), JSON.stringify({ mode: "spa" }));
    expect(() => loadProjectConfig(join(old, "forge"))).toThrow('"mode" must be "framework" or "backend"');
  });
});

describe(".env for the stack", () => {
  test("is created with fresh secrets and private permissions, once", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    expect(ensureEnv(dir, ["postgres"])).toBe(true);
    const first = readFileSync(join(dir, ".env"), "utf8");
    expect(first).toMatch(/BETTER_AUTH_SECRET=[0-9a-f]{64}/);
    expect(first).toContain("POSTGRES_PASSWORD=");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(ensureEnv(dir, ["postgres"])).toBe(false); // it holds the keys to the data: never replaced
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(first);
  });
});

describe("app/ is frontend code too", () => {
  test("it may import forge/_generated and nothing else from forge/", async () => {
    const dir = fresh();
    scaffold({ dir, mode: "framework", services: [] });
    mkdirSync(join(dir, "forge/_generated"), { recursive: true });
    expect(await checkFrontendImports(join(dir, "forge"))).toEqual([]);
    writeFileSync(join(dir, "app/routes/leak.tsx"), `import { secret } from "../../forge/messages";\nexport default () => secret;\n`);
    const violations = await checkFrontendImports(join(dir, "forge"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("leak.tsx");
  });

  test("nor Forge RPC: it is for calls between backends, so a page can't hold its client or its types", async () => {
    const dir = fresh();
    scaffold({ dir, mode: "framework", services: [] });
    mkdirSync(join(dir, "forge/_generated"), { recursive: true });
    writeFileSync(
      join(dir, "app/routes/rpc.tsx"),
      `import { createForgeRpcClient } from "@archlast/forge-runtime/nest/rpc";\nimport { x } from "../../forge/_generated/rpc";\nexport default () => [createForgeRpcClient, x];\n`,
    );
    const violations = await checkFrontendImports(join(dir, "forge"));
    expect(violations).toHaveLength(2);
    expect(violations.join("\n")).toContain("Forge RPC is for calls between backends");
    expect(violations.join("\n")).toContain("Forge RPC types are for other backends");
  });
});

describe("the command", () => {
  test("help lists what a new user needs first", async () => {
    const { out, code } = await cli(["--help"]);
    expect(code).toBe(0);
    for (const word of ["init [dir]", "dev", "up ", "down [--volumes]", "build [--tag", "--mode <framework|backend>"]) expect(out).toContain(word);
  });

  test("a mistyped option is one line, and --version says the version", async () => {
    const bad = await cli(["dev", "--prot", "3000"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Unknown option '--prot'");
    expect(bad.err).not.toContain("    at "); // no stack trace
    const v = await cli(["--version"]);
    expect(v.code).toBe(0);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("init hands over to the scaffolder, with its flags", async () => {
    const dir = fresh("from-init");
    const { out, code } = await cli(["init", dir, "--mode", "backend", "--services", "none", "--yes", "--no-install", "--no-git"]);
    expect(code).toBe(0);
    expect(out).toContain("Created from-init");
    expect(JSON.parse(readFileSync(join(dir, "archlast-forge.json"), "utf8"))).toEqual({ mode: "backend", services: [] });
    expect(existsSync(join(dir, "compose.yaml"))).toBe(true);
  });

  test("starting a full-stack app that wasn't built says what to run", async () => {
    const dir = fresh("unbuilt");
    scaffold({ dir, mode: "framework", services: [] });
    const { err, code } = await cli(["start", "--no-docker", "--dir", join(dir, "forge")]);
    expect(code).toBe(1);
    expect(err).toContain("No production build");
    expect(err).toContain("build --no-docker");
  }, 20_000); // the scaffold runs Prettier

  test("up in a folder that isn't a project says how to make one", async () => {
    const dir = fresh("empty");
    mkdirSync(join(dir, "forge"), { recursive: true });
    writeFileSync(join(dir, "forge/schema.ts"), "export default {}");
    const { err, code } = await cli(["up", "--dir", join(dir, "forge")]);
    expect(code).toBe(1);
    expect(err).toContain("archlast-forge init");
  });

  test("down with no compose.yaml names the missing file", async () => {
    const dir = fresh("nostack");
    scaffold({ dir, mode: "backend", services: [] });
    Bun.spawnSync(["rm", join(dir, "compose.yaml")]);
    const { err, code } = await cli(["down", "--dir", join(dir, "forge")]);
    expect(code).toBe(1);
    expect(err).toMatch(/No compose.yaml|Docker isn't available/);
  });
});
