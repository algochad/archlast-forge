import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Cancelled, gather } from "../src/cli";
import { addPrettier, scaffold } from "../src/scaffold";
import { parseFlags } from "../src/options";
import { BASE_COLORS } from "../src/shadcn";
import { parseProjectConfig } from "../src/stack";

setDefaultTimeout(30_000); // every scaffold runs Prettier over the new project

const fresh = (name = "My Chat") => join(mkdtempSync(join(tmpdir(), "afx-create-")), name);
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const files = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)]));

describe("scaffold", () => {
  test("a full-stack app: the name and versions filled in, the config and stack written", () => {
    const dir = fresh();
    scaffold({ dir, mode: "framework", services: [], version: "1.2.3" });
    const pkg = JSON.parse(read(dir, "package.json"));
    expect(pkg.name).toBe("my-chat");
    expect(pkg.dependencies["@archlast/forge-framework"]).toBe("^1.2.3");
    expect(pkg.dependencies.react).toBe("^19.3.1");
    expect(pkg.scripts.dev).toBe("archlast-forge dev");
    expect(JSON.parse(read(dir, "archlast-forge.json"))).toEqual({ mode: "framework", services: [] });
    expect(read(dir, "forge/package.json")).toContain('"@archlast/forge-runtime": "^1.2.3"');
    for (const f of ["app/root.tsx", "app/routes/index.tsx", "app/routes/chat.tsx", "app/routes/sign-in.tsx", "app/styles.css", "public/favicon.svg", "forge/schema.ts", "forge/messages.ts", "Dockerfile", ".dockerignore", "compose.yaml", ".env", ".env.example", ".gitignore", "README.md", "tsconfig.json"])
      expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, "Caddyfile"))).toBe(false);
    expect(Object.keys((Bun.YAML.parse(read(dir, "compose.yaml")) as any).services)).toEqual(["app"]);
    expect(read(dir, "Dockerfile")).toContain("archlast-forge-engine:1.2.3");
  });

  test("a full-stack app made with the defaults gets a compose file for a production setup", async () => {
    const dir = fresh("shop");
    const { services } = await gather({ dir, yes: true, help: false }, false);
    scaffold({ dir, mode: "framework", services });
    const compose = Bun.YAML.parse(read(dir, "compose.yaml")) as any;
    expect(Object.keys(compose.services)).toEqual(["app", "postgres", "redis", "rustfs", "rustfs-init", "caddy"]);
    expect(compose.services.app.ports).toBeUndefined(); // only Caddy is reachable from outside
    expect(compose.services.app.environment.DATABASE_URL).toContain("postgres");
    expect(read(dir, "Caddyfile")).toContain("reverse_proxy app:3000");
    expect(read(dir, ".env")).toContain("BETTER_AUTH_URL=https://${DOMAIN}");
    expect(read(dir, ".env")).not.toContain("ALLOW_INSECURE_HTTP");
    expect(existsSync(join(dir, "forge/files.ts"))).toBe(true);
  });

  test("untick everything and production is SQLite alone: the app, no database, cache, storage or proxy", () => {
    const dir = fresh("lite");
    scaffold({ dir, mode: "framework", services: [] });
    expect(Object.keys((Bun.YAML.parse(read(dir, "compose.yaml")) as any).services)).toEqual(["app"]);
    expect(existsSync(join(dir, "Caddyfile"))).toBe(false);
    expect(read(dir, "compose.yaml")).not.toMatch(/postgres|redis|rustfs/);
    expect(existsSync(join(dir, "forge/files.ts"))).toBe(false);
  });

  test("a backend: forge only, with the full stack by default and an example HTTP route", () => {
    const dir = fresh("api");
    scaffold({ dir, mode: "backend", services: ["postgres", "redis", "s3"], version: "1.2.3" });
    expect(existsSync(join(dir, "app"))).toBe(false);
    expect(existsSync(join(dir, "forge/http.ts"))).toBe(true);
    expect(read(dir, "forge/http.ts")).toContain("Hello from api");
    expect(Object.keys((Bun.YAML.parse(read(dir, "compose.yaml")) as any).services)).toEqual(["app", "postgres", "redis", "rustfs", "rustfs-init"]);
    expect(read(dir, "forge/files.ts")).toContain("generateUploadUrl"); // storage is there, so is a way to use it
    expect(read(dir, ".env")).toMatch(/POSTGRES_PASSWORD=[0-9a-f]{32}/);
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@archlast/forge-cli"]).toBe("^1.2.3");
  });

  test("with shadcn/ui: Tailwind, the components, the chosen theme and the aliases", () => {
    const dir = fresh("ui");
    scaffold({ dir, mode: "framework", services: [], shadcn: "zinc", version: "1.2.3" });
    expect(JSON.parse(read(dir, "components.json"))).toMatchObject({ style: "base-nova", tailwind: { css: "app/styles.css", baseColor: "zinc", cssVariables: true }, aliases: { ui: "@/components/ui", utils: "@/lib/utils" } });
    const pkg = JSON.parse(read(dir, "package.json"));
    expect(pkg.dependencies).toMatchObject({ tailwindcss: expect.any(String), "@base-ui/react": expect.any(String), cn: expect.any(String), "@archlast/forge-framework": "^1.2.3" });
    expect(pkg.devDependencies["bun-plugin-tailwind"]).toBeString();
    expect(JSON.parse(read(dir, "tsconfig.json")).compilerOptions.paths).toEqual({ "@/*": ["./app/*"] });
    for (const f of ["app/lib/utils.ts", "app/components/ui/button.tsx", "app/components/ui/card.tsx", "app/components/theme-toggle.tsx", "app/routes/chat.tsx"]) expect(existsSync(join(dir, f)), f).toBe(true);
    const css = read(dir, "app/styles.css");
    expect(css).toStartWith('@import "tailwindcss";');
    expect(css).toMatch(/:root \{[^}]*--background: oklch/);
    expect(css).toMatch(/\.dark \{[^}]*--background: oklch/);
    expect(css).not.toContain("/*:root*/");
    expect(read(dir, "app/root.tsx")).toContain('from "@/components/ui/button"'); // the pages use the components, not the plain stylesheet
    expect(read(dir, "README.md")).toContain("bunx shadcn@latest add");
    for (const f of files(dir)) expect(read(dir, f), f).not.toMatch(/__NAME__|__VERSION__/);
  });

  test("each base color has its own theme, and a plain app has none of it", () => {
    const themes = BASE_COLORS.map((c) => {
      const dir = fresh(`c-${c}`);
      scaffold({ dir, mode: "framework", services: [], shadcn: c });
      return /--muted-foreground: (oklch\([^)]*\))/.exec(read(dir, "app/styles.css"))![1];
    });
    expect(new Set(themes).size).toBe(BASE_COLORS.length);
    const plain = fresh("plain");
    scaffold({ dir: plain, mode: "framework", services: [] });
    expect(existsSync(join(plain, "components.json"))).toBe(false);
    expect(read(plain, "package.json")).not.toContain("tailwind");
    expect(read(plain, "app/styles.css")).toContain("--accent:"); // the plain stylesheet
  });

  test("shadcn/ui is for full-stack apps", () => {
    expect(() => scaffold({ dir: fresh("nope"), mode: "backend", services: [], shadcn: "neutral" })).toThrow("use --mode framework");
  });

  test("the upload example comes only with storage", () => {
    const dir = fresh("no-files");
    scaffold({ dir, mode: "backend", services: ["postgres"] });
    expect(existsSync(join(dir, "forge/files.ts"))).toBe(false);
  });

  test("with Caddy there is a Caddyfile for the app and its storage", () => {
    const dir = fresh("secure");
    scaffold({ dir, mode: "backend", services: ["s3", "caddy"] });
    expect(read(dir, "Caddyfile")).toContain("reverse_proxy app:3000");
    expect(read(dir, "Caddyfile")).toContain("reverse_proxy rustfs:9000");
  });

  test("nothing is left unfilled, and the secrets stay out of anything committed", () => {
    for (const mode of ["framework", "backend"] as const) {
      const dir = fresh(mode);
      scaffold({ dir, mode, services: ["postgres", "redis", "s3"], version: "9.9.9" });
      for (const f of files(dir)) expect(read(dir, f), f).not.toMatch(/__NAME__|__VERSION__/);
      const secret = /BETTER_AUTH_SECRET=(\w{64})/.exec(read(dir, ".env"))![1]!;
      for (const f of files(dir).filter((f) => f !== ".env")) expect(read(dir, f), f).not.toContain(secret);
      expect(read(dir, ".gitignore").split("\n")).toContain(".env");
      expect(read(dir, ".gitignore").split("\n")).toContain(".forge");
      expect(read(dir, ".dockerignore").split("\n")).toContain(".env");
      expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
      expect(read(dir, ".env.example")).toContain("BETTER_AUTH_SECRET=\n");
    }
  });

  test("a new project is formatted with Prettier, four spaces to an indent", () => {
    for (const [mode, services, shadcn] of [["backend", ["postgres", "redis", "s3", "caddy"]], ["framework", ["s3"], "zinc"]] as const) {
      const dir = fresh(mode);
      scaffold({ dir, mode, services: [...services], shadcn });
      expect(JSON.parse(read(dir, ".prettierrc"))).toEqual({ tabWidth: 4 });
      expect(read(dir, ".prettierignore")).toContain("forge/_generated"); // codegen writes it its own way
      expect(JSON.parse(read(dir, "package.json"))).toMatchObject({ scripts: { format: "prettier --write ." }, devDependencies: { prettier: expect.any(String) } });
      expect(read(dir, "forge/schema.ts")).toMatch(/\n {4}\w/);
      const check = Bun.spawnSync([process.execPath, require.resolve("prettier/bin/prettier.cjs"), "--check", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(check.stderr.toString(), mode).toBe("");
      expect(check.exitCode).toBe(0);
    }
  });

  test("a project from before the Prettier setup gets each missing piece once, and keeps a config of its own", () => {
    const dir = fresh("old");
    scaffold({ dir, mode: "backend", services: [] });
    const pkg = JSON.parse(read(dir, "package.json"));
    delete pkg.scripts.format;
    delete pkg.devDependencies.prettier;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    for (const f of [".prettierrc", ".prettierignore"]) rmSync(join(dir, f));
    expect(addPrettier(dir)).toEqual([".prettierrc", ".prettierignore", 'the "format" script', "prettier ^3.9.6 in devDependencies"]);
    expect(read(dir, "package.json")).toStartWith('{\n  "name"'); // the file's own indent
    expect(Object.keys(JSON.parse(read(dir, "package.json")).devDependencies)).toEqual(["@archlast/forge-cli", "prettier", "typescript"]);
    expect(JSON.parse(read(dir, ".prettierrc"))).toEqual({ tabWidth: 4 });
    expect(addPrettier(dir)).toEqual([]);

    const own = fresh("own");
    scaffold({ dir: own, mode: "backend", services: [] });
    rmSync(join(own, ".prettierrc"));
    rmSync(join(own, ".prettierignore"));
    writeFileSync(join(own, "package.json"), JSON.stringify({ ...JSON.parse(read(own, "package.json")), prettier: { semi: false }, scripts: { format: "biome format --write ." } }));
    expect(addPrettier(own)).toEqual([".prettierignore"]);
    expect(existsSync(join(own, ".prettierrc"))).toBe(false);
    expect(JSON.parse(read(own, "package.json")).scripts.format).toBe("biome format --write .");
    expect(addPrettier(fresh("empty"))).toEqual([]); // no package.json: nothing to set up
  });

  test("it refuses a folder that already has files, and says so before writing anything", () => {
    const dir = fresh();
    scaffold({ dir, mode: "backend", services: [] });
    expect(() => scaffold({ dir, mode: "backend", services: [] })).toThrow("isn't empty");
  });
});

describe("flags", () => {
  test("parse the way the usage says", () => {
    expect(parseFlags(["my-app", "--mode", "backend", "--services", "postgres,redis", "--no-install", "--git"])).toMatchObject({ dir: "my-app", mode: "backend", services: ["postgres", "redis"], install: false, git: true, yes: false });
    expect(parseFlags(["-y", "x"])).toMatchObject({ yes: true, dir: "x" });
    expect(parseFlags(["x", "--services", "none"]).services).toEqual([]);
    expect(parseFlags(["x", "--template", "framework"]).mode).toBe("framework");
    expect(parseFlags(["x", "--base-color", "Mist"])).toMatchObject({ baseColor: "mist" });
    expect(parseFlags(["x", "--no-shadcn"]).shadcn).toBe(false);
    expect(parseFlags(["x", "--shadcn"]).shadcn).toBe(true);
  });
  test("mistakes are named", () => {
    expect(() => parseFlags(["--mode", "spa"])).toThrow('Unknown mode "spa". Choose framework or backend.');
    expect(() => parseFlags(["--services", "mysql"])).toThrow('Unknown service "mysql"');
    expect(() => parseFlags(["--base-color", "pink"])).toThrow('Unknown base color "pink". Choose from neutral');
    expect(() => parseFlags(["--no-shadcn", "--base-color", "zinc"])).toThrow("--no-shadcn");
    expect(() => parseFlags(["--mode", "backend", "--shadcn"])).toThrow("use --mode framework");
  });
});

describe("gather (no prompts)", () => {
  test("defaults depend on the mode", async () => {
    const dir = fresh();
    expect(await gather({ dir, yes: true, help: false }, false)).toEqual({ dir, mode: "framework", services: ["postgres", "redis", "s3", "caddy"], shadcn: "neutral", install: false, git: false });
    expect(await gather({ dir, shadcn: false, yes: true, help: false }, false)).not.toHaveProperty("shadcn");
    expect(await gather({ dir, baseColor: "zinc", yes: true, help: false }, false)).toMatchObject({ shadcn: "zinc" });
    const backend = await gather({ dir, mode: "backend", yes: true, help: false }, false);
    expect(backend).toMatchObject({ mode: "backend", services: ["postgres", "redis", "s3"] });
    expect(backend).not.toHaveProperty("shadcn"); // there are no pages to style
    expect(await gather({ dir, mode: "backend", services: [], install: true, yes: true, help: false }, false)).toMatchObject({ services: [], install: true });
  });
  test("a missing folder is an error when nothing can ask", async () => {
    await expect(gather({ yes: true, help: false }, false)).rejects.toThrow("Which folder?");
  });
  test("a folder with files in it is refused up front", async () => {
    const dir = fresh();
    scaffold({ dir, mode: "backend", services: [] });
    await expect(gather({ dir, yes: true, help: false }, false)).rejects.toThrow("already has files");
  });
});

describe("gather (prompts)", () => {
  /** Drives the real prompts with key presses. */
  function terminal() {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} }) as unknown as NodeJS.ReadStream;
    const output = new PassThrough();
    let text = "";
    output.on("data", (c) => (text += String(c)));
    const press = async (...keys: string[]) => {
      for (const k of keys) {
        input.push(k);
        await Bun.sleep(15);
      }
    };
    return { input: input as unknown as import("node:stream").Readable, output, press, screen: () => text };
  }
  const DOWN = "\u001b[B";
  const UP = "\u001b[A";

  test("choosing a backend preselects its services; space toggles one", async () => {
    const t = terminal();
    const dir = fresh("chosen");
    const done = gather({ dir, install: false, git: false, yes: false, help: false }, true, { input: t.input, output: t.output });
    await Bun.sleep(30);
    await t.press(DOWN, "\r"); // What are you building? → Backend only
    await Bun.sleep(30);
    expect(t.screen()).toContain("PostgreSQL");
    await t.press(" "); // the cursor starts on PostgreSQL: untick it
    await t.press("\r", "\r", "\r", "\r"); // the services, no Expo app, no desktop app, one app (not a monorepo)
    expect(await done).toEqual({ dir, mode: "backend", services: ["redis", "s3"], install: false, git: false });
  });

  test("a monorepo is offered after the services, with its microservices and their transport", async () => {
    const t = terminal();
    const dir = fresh("mono");
    const done = gather({ dir, install: false, git: false, yes: false, help: false }, true, { input: t.input, output: t.output });
    await Bun.sleep(30);
    await t.press(DOWN, "\r", "\r", "\r", "\r", DOWN, "\r"); // backend, its services, no Expo app, no desktop app, a monorepo
    await Bun.sleep(30);
    await t.press(..."orders,billing".split(""), "\r", DOWN, DOWN, "\r"); // the services' names, then Redis (Forge RPC is first, then TCP)
    expect(await done).toMatchObject({ mode: "backend", monorepo: { microservices: ["orders", "billing"], transport: "redis" } });
    expect(t.screen()).toContain("One app, or a monorepo?");
    expect(t.screen()).toContain("typed calls between forge apps (recommended)");
  });

  test("shadcn/ui is asked about for a full-stack app: a base color to pick, or no", async () => {
    const pick = terminal();
    const picked = gather({ dir: fresh("zinc"), install: false, git: false, yes: false, help: false }, true, { input: pick.input, output: pick.output });
    await Bun.sleep(30);
    await pick.press("\r", "\r", DOWN, DOWN, "\r", "\r", "\r", "\r", "\r"); // framework, yes, neutral → stone → zinc, the services, no Expo app, no desktop app, one app
    expect(await picked).toMatchObject({ mode: "framework", shadcn: "zinc" });
    expect(pick.screen()).toContain("Add shadcn/ui?");
    expect(pick.screen()).toContain("Taupe");

    const skip = terminal();
    const skipped = gather({ dir: fresh("plain-ui"), install: false, git: false, yes: false, help: false }, true, { input: skip.input, output: skip.output });
    await Bun.sleep(30);
    await skip.press("\r", "n", "\r", "\r", "\r", "\r", "\r"); // framework, no (so no base color), the services, no Expo app, no desktop app, one app
    const answers = await skipped;
    expect(answers.mode).toBe("framework");
    expect(answers).not.toHaveProperty("shadcn");
  });

  test("a full-stack app starts with the production stack ticked; Ctrl-C cancels without a trace", async () => {
    const t = terminal();
    const dir = fresh("plain");
    const done = gather({ dir, install: false, git: false, yes: false, help: false }, true, { input: t.input, output: t.output });
    await Bun.sleep(30);
    await t.press("\r", "\r", "\r", "\r", "\r", "\r", "\r"); // the mode, shadcn/ui (yes), its base color (neutral), the services, no Expo app, no desktop app, one app
    expect(await done).toMatchObject({ mode: "framework", shadcn: "neutral", services: ["postgres", "redis", "s3", "caddy"] });

    const quit = terminal();
    const cancelled = gather({ dir: fresh("never"), yes: false, help: false }, true, { input: quit.input, output: quit.output }).catch((e) => e);
    await Bun.sleep(30);
    await quit.press("\u0003");
    expect(await cancelled).toBeInstanceOf(Cancelled);
  });
});

test("project config", () => {
  expect(parseProjectConfig(JSON.parse(read((() => { const d = fresh(); scaffold({ dir: d, mode: "backend", services: ["redis"] }); return d; })(), "archlast-forge.json")))).toEqual({ mode: "backend", services: ["redis"] });
});

test("the command itself runs end to end (the entry point, not just its parts)", async () => {
  const dir = fresh("from-cli");
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), dir, "--mode", "backend", "--services", "redis", "--yes", "--no-install", "--no-git"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  expect(out).toContain("Created from-cli (backend only, with Redis)");
  expect(out).toContain("bun run dev");
  expect(JSON.parse(read(dir, "archlast-forge.json"))).toEqual({ mode: "backend", services: ["redis"] });

  const bad = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), dir, "--yes"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await bad.exited).toBe(1);
  expect(await new Response(bad.stderr).text()).toContain("already has files");
  const help = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), "--help"], { stdin: "ignore", stdout: "pipe" });
  expect(await new Response(help.stdout).text()).toContain("--mode <framework|backend>");
});
