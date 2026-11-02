import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BASE_COLORS, parseBaseColor, type BaseColor } from "./shadcn";
import { DEFAULT_SERVICES, MODES, parseServiceList, type Mode, type StackService } from "./stack";
import { parseMicroservices, TRANSPORTS, type Transport } from "./monorepo";
import { DESKTOP_MODES, type DesktopMode } from "./desktop";

export interface Flags {
  dir?: string;
  mode?: Mode;
  services?: StackService[];
  shadcn?: boolean;
  baseColor?: BaseColor;
  /** A Turborepo monorepo: the app in apps/, with these backends beside it as microservices. */
  monorepo?: boolean;
  microservices?: string[];
  transport?: Transport;
  /** A React Native (Expo) app beside a backend. */
  mobile?: boolean;
  /** A Tauri desktop app: full (the engine on the user's machine) or client. */
  desktop?: DesktopMode;
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
  --monorepo                   a Turborepo monorepo: the app in apps/, shared API types in packages/api
  --microservices <names>      backends to add beside it (orders,billing), each called from the app over Forge RPC or another NestJS transport
  --transport <forge-rpc|tcp|redis|nats>
                               how the services talk. Default: forge-rpc (typed calls between forge apps)
  --mobile                     a React Native (Expo) app in apps/mobile, a client of the app: a full-stack app or a backend.
                               Implies --monorepo
  --desktop <full|client>      a Tauri desktop app in apps/desktop. full: the full-stack app with its engine on the user's
                               machine (--mode framework); client: a page that talks to a backend elsewhere. Implies --monorepo
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
      monorepo: { type: "boolean" },
      microservices: { type: "string" },
      transport: { type: "string" },
      mobile: { type: "boolean" },
      desktop: { type: "string" },
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
  const transport = values.transport;
  if (transport !== undefined && !(TRANSPORTS as readonly string[]).includes(transport)) throw new Error(`Unknown transport "${transport}". Choose ${TRANSPORTS.join(", ")}.`);
  const microservices = values.microservices === undefined ? undefined : parseMicroservices(values.microservices);
  const desktop = values.desktop;
  if (desktop !== undefined && !(DESKTOP_MODES as readonly string[]).includes(desktop)) throw new Error(`Unknown desktop mode "${desktop}". Choose full or client.`);
  if (desktop === "full" && mode === "backend") throw new Error("--desktop full runs the full-stack app on the user's machine: use --mode framework (or --desktop client for a backend)");
  return {
    dir: positionals[0],
    monorepo: values.monorepo || microservices !== undefined || transport !== undefined || values.mobile || desktop !== undefined ? true : undefined,
    mobile: values.mobile ? true : undefined,
    desktop: desktop as DesktopMode | undefined,
    microservices,
    transport: transport as Transport | undefined,
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
