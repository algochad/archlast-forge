import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Cancelled, gather } from "../src/cli";
import { scaffold } from "../src/scaffold";
import { parseFlags } from "../src/options";
import { parseProjectConfig } from "../src/stack";

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
    expect(pkg.dependencies["@archlast-forge/framework"]).toBe("^1.2.3");
    expect(pkg.dependencies.react).toBe("^19.3.1");
    expect(pkg.scripts.dev).toBe("archlast-forge dev");
    expect(JSON.parse(read(dir, "archlast-forge.json"))).toEqual({ mode: "framework", services: [] });
    expect(read(dir, "forge/package.json")).toContain('"@archlast-forge/runtime": "^1.2.3"');
    for (const f of ["app/root.tsx", "app/routes/index.tsx", "app/routes/chat.tsx", "app/routes/sign-in.tsx", "app/styles.css", "public/favicon.svg", "forge/schema.ts", "forge/messages.ts", "Dockerfile", ".dockerignore", "compose.yaml", ".env", ".env.example", ".gitignore", "README.md", "tsconfig.json"])
      expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, "Caddyfile"))).toBe(false);
    expect(Object.keys((Bun.YAML.parse(read(dir, "compose.yaml")) as any).services)).toEqual(["app"]);
    expect(read(dir, "Dockerfile")).toContain("archlast-forge-engine:1.2.3");
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
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@archlast-forge/cli"]).toBe("^1.2.3");
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
  });
  test("mistakes are named", () => {
    expect(() => parseFlags(["--mode", "spa"])).toThrow('Unknown mode "spa". Choose framework or backend.');
    expect(() => parseFlags(["--services", "mysql"])).toThrow('Unknown service "mysql"');
  });
});

describe("gather (no prompts)", () => {
  test("defaults depend on the mode", async () => {
    const dir = fresh();
    expect(await gather({ dir, yes: true, help: false }, false)).toEqual({ dir, mode: "framework", services: [], install: false, git: false });
    expect(await gather({ dir, mode: "backend", yes: true, help: false }, false)).toMatchObject({ mode: "backend", services: ["postgres", "redis", "s3"] });
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
    await t.press("\r");
    expect(await done).toEqual({ dir, mode: "backend", services: ["redis", "s3"], install: false, git: false });
  });

  test("a full-stack app starts with nothing ticked; Ctrl-C cancels without a trace", async () => {
    const t = terminal();
    const dir = fresh("plain");
    const done = gather({ dir, install: false, git: false, yes: false, help: false }, true, { input: t.input, output: t.output });
    await Bun.sleep(30);
    await t.press("\r", "\r");
    expect(await done).toMatchObject({ mode: "framework", services: [] });

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
