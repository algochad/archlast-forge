import * as p from "@clack/prompts";
import { existsSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { scaffold } from "./scaffold";
import { defaultServices, nameOf, parseFlags, USAGE, type Flags } from "./options";
import { DEFAULT_SERVICES, MODES, SERVICES, type Mode, type StackService } from "./stack";

/** Where prompts read and write; tests pass their own streams. */
export interface Io {
  input?: Readable;
  output?: Writable;
}

export interface Answers {
  dir: string;
  mode: Mode;
  services: StackService[];
  install: boolean;
  git: boolean;
}

/** The person pressed Ctrl-C at a prompt. */
export class Cancelled extends Error {}

const answer = <T>(value: T | symbol): T => {
  if (p.isCancel(value)) throw new Cancelled("Cancelled");
  return value as T;
};

const dirProblem = (dir: string) => (existsSync(resolve(dir)) && readdirSync(resolve(dir)).length ? `${dir} already has files in it. Pick an empty folder or a new name.` : undefined);

/** Asks for whatever the flags left out. With `interactive` false, missing answers take their defaults. */
export async function gather(flags: Flags, interactive: boolean, io: Io = {}): Promise<Answers> {
  const ask = <T>(run: (o: Io) => Promise<T | symbol>): Promise<T> => run(io).then((v) => answer<T>(v));

  let dir = flags.dir;
  if (dir === undefined) {
    if (!interactive) throw new Error("Which folder? Pass a directory: bun create archlast-forge my-app");
    dir = await ask<string>((o) =>
      p.text({ ...o, message: "Where should we create your project?", placeholder: "my-app", defaultValue: "my-app", validate: (v) => dirProblem(v || "my-app") }),
    );
  } else {
    const problem = dirProblem(dir);
    if (problem) throw new Error(problem);
  }

  let mode: Mode;
  if (flags.mode) mode = flags.mode;
  else {
    mode = interactive
      ? await ask<Mode>((o) =>
          p.select<Mode>({
            ...o,
            message: "What are you building?",
            initialValue: "framework",
            options: (Object.keys(MODES) as Mode[]).map((m) => ({ value: m, label: MODES[m].label, hint: MODES[m].hint })),
          }),
        )
      : "framework";
  }

  let services = flags.services;
  if (!services) {
    services = interactive
      ? await ask<StackService[]>((o) =>
          p.multiselect<StackService>({
            ...o,
            message: mode === "backend" ? "Which services should run with it? (space selects, enter confirms)" : "Add services to the stack? (none is fine: SQLite needs nothing)",
            required: false,
            initialValues: DEFAULT_SERVICES[mode],
            options: (Object.keys(SERVICES) as StackService[]).map((s) => ({ value: s, label: SERVICES[s].label, hint: SERVICES[s].hint })),
          }),
        )
      : defaultServices(mode);
  }

  const confirm = async (given: boolean | undefined, message: string) => given ?? (interactive ? await ask<boolean>((o) => p.confirm({ ...o, message, initialValue: true })) : false);
  const install = await confirm(flags.install, "Install dependencies with bun?");
  const git = await confirm(flags.git, "Start a git repository?");
  return { dir, mode, services, install, git };
}

const run = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, output: (err || out).trim() };
};

export function nextSteps(a: Answers, installed: boolean): string {
  const rel = relative(process.cwd(), resolve(a.dir)) || ".";
  const cd = rel.startsWith("..") ? resolve(a.dir) : rel; // a path that climbs out of here reads better in full
  const lines = [cd !== "." ? `cd ${cd}` : undefined, installed ? undefined : "bun install", "bun run dev"].filter(Boolean) as string[];
  const where = a.mode === "framework" ? "Your app: http://localhost:3000" : "Your backend: http://localhost:3000";
  return `${lines.join("\n")}\n\n${where}\nDashboard: http://localhost:3000/_dashboard\n\nTo deploy: bun run up   (builds the image and starts the stack in compose.yaml)`;
}

export async function main(argv: string[], io: Io = {}): Promise<void> {
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (flags.help) return console.log(USAGE);
  const interactive = !flags.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;

  if (interactive) p.intro(" create archlast-forge ");
  let answers: Answers;
  try {
    answers = await gather(flags, interactive, io);
  } catch (e) {
    if (e instanceof Cancelled) {
      p.cancel("Cancelled. Nothing was created.");
      process.exit(130);
    }
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }

  const target = (() => {
    try {
      return scaffold(answers);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      return process.exit(1);
    }
  })();
  p.log.success(`Created ${basename(target)} (${MODES[answers.mode].label.toLowerCase()}${answers.services.length ? `, with ${answers.services.map((s) => SERVICES[s].label).join(", ")}` : ""})`);

  let installed = false;
  if (answers.install) {
    const spin = p.spinner();
    spin.start("Installing dependencies");
    const r = await run(["bun", "install"], target);
    installed = r.ok;
    if (r.ok) spin.stop("Installed dependencies");
    else spin.error(`bun install failed:\n${r.output.split("\n").slice(-8).join("\n")}\nRun it again once that is fixed.`);
  }
  if (answers.git && !existsSync(resolve(target, ".git"))) {
    const r = await run(["git", "init", "-q"], target);
    if (r.ok) p.log.success("Started a git repository");
    else p.log.warn("Couldn't start a git repository (is git installed?)");
  }
  p.note(nextSteps(answers, installed), "Next");
  p.outro("Happy building.");
}
