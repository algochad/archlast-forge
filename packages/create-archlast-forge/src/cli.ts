import * as p from "@clack/prompts";
import { existsSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { scaffold } from "./scaffold";
import { parseMicroservices, scaffoldMonorepo, TRANSPORT_LABEL, TRANSPORTS, type Transport } from "./monorepo";
import type { DesktopMode } from "./desktop";
import { BASE_COLORS, BASE_COLOR_HINTS, type BaseColor } from "./shadcn";
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
  /** Full-stack apps: the shadcn/ui base color, or nothing for a plain app. */
  shadcn?: BaseColor;
  /** A monorepo, with these microservices beside the app. */
  monorepo?: { microservices: string[]; transport: Transport; mobile?: boolean; desktop?: DesktopMode };
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

  let shadcn: BaseColor | undefined;
  if (mode === "framework") {
    const use = flags.shadcn ?? (flags.baseColor ? true : interactive ? await ask<boolean>((o) => p.confirm({ ...o, message: "Add shadcn/ui? (Tailwind CSS and ready-made components)", initialValue: true })) : true);
    if (use)
      shadcn =
        flags.baseColor ??
        (interactive
          ? await ask<BaseColor>((o) =>
              p.select<BaseColor>({ ...o, message: "Which base color for the theme?", initialValue: "neutral", options: BASE_COLORS.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1), hint: BASE_COLOR_HINTS[c] })) }),
            )
          : "neutral");
  }

  let services = flags.services;
  if (!services) {
    services = interactive
      ? await ask<StackService[]>((o) =>
          p.multiselect<StackService>({
            ...o,
            message: "Which services will production need? (space selects, enter confirms; none keeps SQLite, with no database container)",
            required: false,
            initialValues: DEFAULT_SERVICES[mode],
            options: (Object.keys(SERVICES) as StackService[]).map((s) => ({ value: s, label: SERVICES[s].label, hint: SERVICES[s].hint })),
          }),
        )
      : defaultServices(mode);
  }

  // A phone app is a client of the app: its engine serves the same API and sign-in whether it is a full-stack app or a backend.
  const mobile =
    flags.mobile ??
    (interactive ? await ask<boolean>((o) => p.confirm({ ...o, message: "Add a React Native (Expo) app? It is a client of this app", initialValue: false })) : false);
  // A desktop app: the full-stack app with its engine on the user's machine (full-stack apps only), or a client of a backend.
  const desktop =
    flags.desktop ??
    (interactive
      ? await ask<DesktopMode | "none">((o) =>
          p.select<DesktopMode | "none">({
            ...o,
            message: "Add a desktop app (Tauri)?",
            initialValue: "none",
            options: [
              { value: "none", label: "No" },
              ...(mode === "framework" ? [{ value: "full" as const, label: "Yes, the whole app on the user's machine", hint: "its engine runs inside the desktop app, no Docker" }] : []),
              { value: "client" as const, label: "Yes, a client of the backend", hint: "a page that talks to the deployed backend" },
            ],
          }),
        )
      : "none");
  const wantsDesktop = desktop !== "none" ? desktop : undefined;
  let monorepo: Answers["monorepo"];
  const wantsMonorepo =
    Boolean(wantsDesktop) ||
    mobile ||
    (flags.monorepo ??
    (interactive
      ? (await ask<string>((o) =>
          p.select({ ...o, message: "One app, or a monorepo?", initialValue: "single", options: [{ value: "single", label: "One app" }, { value: "monorepo", label: "A monorepo (Turborepo)", hint: "apps/, shared API types, optional microservices" }] }),
        )) === "monorepo"
      : false));
  if (wantsMonorepo) {
    const microservices =
      flags.microservices ??
      (interactive
        ? parseMicroservices(await ask<string>((o) => p.text({ ...o, message: "Microservices to add beside the app? (comma-separated names, empty for none)", placeholder: "orders,billing", defaultValue: "", validate: (v) => { try { parseMicroservices(v ?? ""); } catch (e) { return (e as Error).message; } } })))
        : []);
    const transport =
      flags.transport ??
      (interactive && microservices.length
        ? await ask<Transport>((o) => p.select<Transport>({ ...o, message: "How do the services talk?", initialValue: "forge-rpc", options: TRANSPORTS.map((t) => ({ value: t, label: TRANSPORT_LABEL[t], hint: t === "forge-rpc" ? "typed calls between forge apps (recommended)" : t === "tcp" ? "untyped messages, no server needed" : `needs a ${TRANSPORT_LABEL[t]} server` })) }))
        : "forge-rpc");
    monorepo = { microservices, transport, ...(mobile && { mobile: true }), ...(wantsDesktop && { desktop: wantsDesktop }) };
  }

  const confirm = async (given: boolean | undefined, message: string) => given ?? (interactive ? await ask<boolean>((o) => p.confirm({ ...o, message, initialValue: true })) : false);
  const install = await confirm(flags.install, "Install dependencies with bun?");
  const git = await confirm(flags.git, "Start a git repository?");
  return { dir, mode, services, ...(shadcn && { shadcn }), ...(monorepo && { monorepo }), install, git };
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
  const where = a.monorepo
    ? `apps/${a.mode === "framework" ? "web" : "api"}: http://localhost:3000${a.monorepo.microservices.map((s, i) => `\napps/${s}: http://localhost:${3001 + i}`).join("")}${a.monorepo.mobile ? "\napps/mobile: Expo (scan the QR code that bun run dev prints)" : ""}${a.monorepo.desktop ? "\napps/desktop: Tauri (needs Rust; see its README)" : ""}`
    : a.mode === "framework"
      ? "Your app: http://localhost:3000"
      : "Your backend: http://localhost:3000";
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
      return answers.monorepo ? scaffoldMonorepo({ ...answers, ...answers.monorepo }) : scaffold(answers);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      return process.exit(1);
    }
  })();
  const included = [...(answers.shadcn ? [`shadcn/ui (${answers.shadcn})`] : []), ...answers.services.map((s) => SERVICES[s].label)];
  p.log.success(`Created ${basename(target)} (${MODES[answers.mode].label.toLowerCase()}${included.length ? `, with ${included.join(", ")}` : ""})`);

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
