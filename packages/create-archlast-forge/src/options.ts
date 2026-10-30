import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BASE_COLORS, parseBaseColor, type BaseColor } from "./shadcn";
import { DEFAULT_SERVICES, MODES, parseServiceList, type Mode, type StackService } from "./stack";

export interface Flags {
  dir?: string;
  mode?: Mode;
  services?: StackService[];
  shadcn?: boolean;
  baseColor?: BaseColor;
  yes: boolean;
  install?: boolean;
  git?: boolean;
  help: boolean;
}

export const USAGE = `Usage: bun create archlast-forge [directory] [options]

  --mode <framework|backend>   framework: a full-stack React app (server rendering, file routes, live queries)
                               backend:   a backend container with its own database, cache and storage
  --services <list>            postgres, redis, s3, caddy (comma separated) or "none"
  --shadcn / --no-shadcn       full-stack apps: use shadcn/ui (Tailwind CSS and components). Default: yes
  --base-color <name>          shadcn/ui's base color: ${BASE_COLORS.join(", ")}. Default: neutral
  --install / --no-install     run \`bun install\` afterwards
  --git / --no-git             start a git repository
  -y, --yes                    take the default for everything not given, and ask nothing
  -h, --help

Without options you are asked. Defaults: framework mode with postgres, redis, s3 and caddy;
backend mode with postgres, redis and s3.`;

export function parseFlags(argv: string[]): Flags {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mode: { type: "string", short: "m" },
      template: { type: "string" },
      services: { type: "string", short: "s" },
      shadcn: { type: "boolean" },
      "no-shadcn": { type: "boolean" },
      "base-color": { type: "string" },
      install: { type: "boolean" },
      "no-install": { type: "boolean" },
      git: { type: "boolean" },
      "no-git": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  const mode = values.mode ?? values.template;
  if (mode !== undefined && !(mode in MODES)) throw new Error(`Unknown mode "${mode}". Choose framework or backend.`);
  const pick = (on?: boolean, off?: boolean) => (off ? false : on ? true : undefined);
  const baseColor = values["base-color"] === undefined ? undefined : parseBaseColor(values["base-color"]);
  const shadcn = pick(values.shadcn, values["no-shadcn"]);
  if (shadcn === false && baseColor) throw new Error("--base-color is for shadcn/ui, which --no-shadcn turns off");
  if ((shadcn || baseColor) && mode === "backend") throw new Error("shadcn/ui is for full-stack apps: use --mode framework");
  return {
    dir: positionals[0],
    mode: mode as Mode | undefined,
    services: values.services === undefined ? undefined : parseServiceList(values.services),
    shadcn,
    baseColor,
    yes: Boolean(values.yes),
    install: pick(values.install, values["no-install"]),
    git: pick(values.git, values["no-git"]),
    help: Boolean(values.help),
  };
}

/** A name safe for package.json and Docker Compose: lowercase letters, digits, `-` and `_`. */
export function nameOf(dir: string): string {
  return basename(resolve(dir)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || "app";
}

export const defaultServices = (mode: Mode, given?: StackService[]) => given ?? DEFAULT_SERVICES[mode];
