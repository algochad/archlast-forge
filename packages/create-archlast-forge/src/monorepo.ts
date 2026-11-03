// A Turborepo monorepo: the main app in apps/, backends that serve as microservices beside it, wired with Forge RPC (or another NestJS
// transport), and the backends' generated API types shared from packages/api (and their Forge RPC types from packages/contracts).
// `scaffoldMonorepo` makes one from nothing; the pieces below are also what `add`, `remove` and `monorepo` (evolve.ts) use on one that exists.
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addDesktop, type DesktopMode } from "./desktop";
import { nameOf } from "./options";
import { addPrettier, format, isFormatted, scaffold, VERSION } from "./scaffold";
import type { BaseColor } from "./shadcn";
import type { Mode, StackService } from "./stack";
import { appPackage, backendsOf, camel, checkAppName, env, isMonorepo, modeOf, packageOf, pascal, servicesOf, TRANSPORT_LABEL, TRANSPORTS, WORKSPACE_FILE, writeWorkspace, type Transport, type Workspace } from "./workspace";

export { isMonorepo, TRANSPORT_LABEL, TRANSPORTS, type Transport };

export interface MonorepoOptions {
  dir: string;
  mode: Mode;
  services: StackService[];
  shadcn?: BaseColor;
  /** Backends to add as microservices, by name (`orders`, `billing`). */
  microservices?: string[];
  transport?: Transport;
  /** A React Native (Expo) app in apps/mobile, a client of the main app, whether that is a full-stack app or a backend. */
  mobile?: boolean;
  /** A Tauri desktop app in apps/desktop: the full-stack app with its engine on the user's machine, or a client of a backend. */
  desktop?: DesktopMode;
  version?: string;
}

const MOBILE = new URL("../template/mobile", import.meta.url).pathname;

export function parseMicroservices(text: string): string[] {
  const names = text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const n of names) checkAppName(n);
  if (new Set(names).size !== names.length) throw new Error("A service is named twice");
  return names;
}

/** How a client reaches microservice `name` (listening on `port`) over `transport`, as Nest's options, read from the environment with local defaults. */
function transportOptions(transport: Exclude<Transport, "forge-rpc">, name: string, port: number, listen: boolean) {
  if (transport === "tcp") return `{ transport: Transport.TCP, options: { host: process.env.${env(name)}_HOST ?? "${listen ? "0.0.0.0" : "127.0.0.1"}", port: Number(process.env.${env(name)}_PORT ?? ${port}) } }`;
  if (transport === "redis") return `{ transport: Transport.REDIS, options: redisOptions(process.env.MICROSERVICES_REDIS_URL ?? "redis://127.0.0.1:6379") }`;
  return `{ transport: Transport.NATS, options: { servers: [process.env.MICROSERVICES_NATS_URL ?? "nats://127.0.0.1:4222"] } }`;
}
const REDIS_HELPER = `
/** Nest's Redis transport takes host and port, not a URL. */
const redisOptions = (url: string) => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379), ...(u.password && { password: decodeURIComponent(u.password) }) };
};
`;
/** The client package a transport needs in forge/package.json (TCP and Forge RPC need none). */
const TRANSPORT_PACKAGE: Record<Transport, [string, string] | undefined> = { "forge-rpc": undefined, tcp: undefined, redis: ["ioredis", "^5.6.1"], nats: ["nats", "^2.29.3"] };

/** What a step of building or changing a monorepo works with. */
export interface Ctx {
  root: string;
  /** The monorepo's name: its root package.json's, the scope of its packages (`@<name>/api`). */
  name: string;
  version: string;
  ws: Workspace;
  /** The files this run wrote, relative to `root`: the ones to format (a command that changes a project formats only its own files). */
  written: string[];
  /** What is left for the user to do by hand, because it is in code the run doesn't own. */
  notes: string[];
}

export const newCtx = (root: string, name: string, version: string, ws: Workspace): Ctx => ({ root, name, version, ws, written: [], notes: [] });

const write = (path: string, text: string) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, text));
/** Writes a file of this run's and remembers it for formatting. `rel` is relative to the monorepo's root. */
const put = (c: Ctx, rel: string, text: string) => (write(join(c.root, rel), text), void c.written.push(rel));
/** Changes a JSON file, keeping its own indentation (a project's files are Prettier's 4 spaces, the monorepo's own 2). */
export const patchJson = (path: string, change: (json: any) => void) => {
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text);
  change(json);
  writeFileSync(path, JSON.stringify(json, null, /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2) + "\n");
};

const forgeRel = (app: string) => `apps/${app}/forge`;

/** apps/<svc>: the service's own backend, a project like `init` makes, with a mutation of its own and the router or controller that serves it. */
export function writeService(c: Ctx, svc: string) {
  const { root, name, version, ws } = c;
  const { port, rpcPort = 4001 } = ws.apps[svc]!;
  scaffold({ dir: join(root, "apps", svc), mode: "backend", services: [], version, name: `${name}-${svc}` });
  // Each runs on its own port in development (the main app keeps 3000), on this machine, so the transports' ports are reachable.
  patchJson(join(root, "apps", svc, "package.json"), (pkg) => {
    pkg.name = packageOf(name, svc);
    pkg.scripts.dev = `archlast-forge dev --no-docker --port ${port}`;
  });
  const forge = forgeRel(svc);
  // The service: a message pattern that does its own work (a mutation in its own database) and answers.
  writeFileSync(
    join(root, forge, "schema.ts"),
    readFileSync(join(root, forge, "schema.ts"), "utf8").replace("export default defineSchema({\n", "export default defineSchema({\n  calls: defineTable({ from: v.string(), at: v.number() }),\n"),
  );
  c.written.push(`${forge}/schema.ts`);
  put(
    c,
    `${forge}/calls.ts`,
    `import { internalMutation, v } from "@archlast/forge-runtime";

/** Records a call this service answered, and says how many it has. */
export const record = internalMutation({
  args: { from: v.string() },
  handler: async (ctx, { from }) => {
    await ctx.db.insert("calls", { from, at: Date.now() });
    return ctx.db.query("calls").count();
  },
});
`,
  );
  if (ws.transport === "forge-rpc") {
    put(
      c,
      `${forge}/${svc}.router.ts`,
      `import { internal } from "./_generated/api";
import type { ActionCtx } from "@archlast/forge-runtime/nest";
import { Ctx, Input, Mutation, Router, z } from "@archlast/forge-runtime/nest/rpc";

/**
 * What ${svc} serves over Forge RPC. \`archlast-forge codegen\` writes its types to
 * forge/_generated/rpc.ts, which packages/contracts shares, and other apps call \`${camel(svc)}.hello\` with them.
 */
@Router({ alias: "${camel(svc)}" })
export class ${pascal(svc)}Router {
  @Mutation({ input: z.object({ from: z.string() }), output: z.object({ service: z.string(), greeting: z.string(), calls: z.number() }) })
  async hello(@Input("from") from: string, @Ctx() ctx: ActionCtx) {
    const calls = await ctx.runMutation(internal.calls.record, { from });
    return { service: "${svc}", greeting: \`Hello, \${from}\`, calls };
  }
}
`,
    );
    put(
      c,
      `${forge}/http.ts`,
      `import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { ForgeRpcServer } from "@archlast/forge-runtime/nest/rpc";
import { ${pascal(svc)}Router } from "./${svc}.router";

const http = httpRouter();
http.route({ method: "GET", path: "/hello", handler: httpAction(async () => Response.json({ message: "Hello from ${svc}" })) });

// ${svc} serves its routers to the other apps here, in the engine's first function runtime process. They send FORGE_RPC_TOKEN (.env).
nest(http, { controllers: [${pascal(svc)}Router], microservices: [{ strategy: new ForgeRpcServer({ port: Number(process.env.${env(svc)}_RPC_PORT ?? ${rpcPort}) }) }] });

export default http;
`,
    );
    return;
  }
  put(
    c,
    `${forge}/${svc}.controller.ts`,
    `import { internal } from "./_generated/api";
import { Controller, type ActionCtx } from "@archlast/forge-runtime/nest";
import { Ctx, MessagePattern, Payload } from "@archlast/forge-runtime/nest/microservices";

/** What ${svc} answers over the ${TRANSPORT_LABEL[ws.transport]} transport. Other services call it with \`send("${svc}.hello", { from })\`. */
@Controller()
export class ${pascal(svc)}Controller {
  @MessagePattern("${svc}.hello")
  async hello(@Payload() data: { from: string }, @Ctx() ctx: ActionCtx) {
    const calls = await ctx.runMutation(internal.calls.record, { from: data.from });
    return { service: "${svc}", greeting: \`Hello, \${data.from}\`, calls };
  }
}
`,
  );
  put(
    c,
    `${forge}/http.ts`,
    `import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { Transport } from "@archlast/forge-runtime/nest/microservices";
import { ${pascal(svc)}Controller } from "./${svc}.controller";
${ws.transport === "redis" ? REDIS_HELPER : ""}
const http = httpRouter();
http.route({ method: "GET", path: "/hello", handler: httpAction(async () => Response.json({ message: "Hello from ${svc}" })) });

// ${svc} listens for other services' messages here, in the engine's first function runtime process.
nest(http, { controllers: [${pascal(svc)}Controller], microservices: [${transportOptions(ws.transport as Exclude<Transport, "forge-rpc">, svc, rpcPort, true)}] });

export default http;
`,
  );
}

/** The main app's side of service `svc`: a class that makes the calls, a controller over it (POST /http/<svc>/hello), and an action that reaches the same class. */
export function writeCaller(c: Ctx, svc: string) {
  const { name, ws } = c;
  const { rpcPort = 4001 } = ws.apps[svc]!;
  const forge = forgeRel(ws.main);
  const Service = `${pascal(svc)}Service`;
  put(
    c,
    `${forge}/${svc}.service.ts`,
    ws.transport === "forge-rpc"
      ? `import { Injectable } from "@archlast/forge-runtime/nest";
import { createForgeRpcClient } from "@archlast/forge-runtime/nest/rpc";
import type { ${pascal(svc)}Rpc } from "@${name}/contracts";

/** Calls the ${svc} service over Forge RPC, typed from its routers. One client for the app: calls made in the same tick share a request. */
@Injectable()
export class ${Service} {
  private readonly ${camel(svc)} = createForgeRpcClient<${pascal(svc)}Rpc>({ url: process.env.${env(svc)}_RPC_URL ?? "http://127.0.0.1:${rpcPort}" });

  hello(from: string) {
    return this.${camel(svc)}.${camel(svc)}.hello.mutate({ from });
  }
}
`
      : `import { Injectable, rxjs } from "@archlast/forge-runtime/nest";
import { ClientProxyFactory, Transport } from "@archlast/forge-runtime/nest/microservices";
${ws.transport === "redis" ? REDIS_HELPER : ""}
/** Calls the ${svc} service over ${TRANSPORT_LABEL[ws.transport]}: connected on first use, kept for every call after. */
@Injectable()
export class ${Service} {
  private readonly client = ClientProxyFactory.create(${transportOptions(ws.transport as Exclude<Transport, "forge-rpc">, svc, rpcPort, false)});

  hello(from: string) {
    return rxjs.firstValueFrom(this.client.send<{ service: string; greeting: string; calls: number }>("${svc}.hello", { from }));
  }
}
`,
  );
  put(
    c,
    `${forge}/${svc}.controller.ts`,
    `import { Body, Controller, Post } from "@archlast/forge-runtime/nest";
import { ${Service} } from "./${svc}.service";

/** POST /http/${svc}/hello, for the app's clients: the call to the ${svc} service is in ${Service}. */
@Controller("${svc}")
export class ${pascal(svc)}Controller {
  constructor(private readonly ${camel(svc)}: ${Service}) {}

  @Post("hello")
  hello(@Body() body: { from: string }) {
    return this.${camel(svc)}.hello(body.from);
  }
}
`,
  );
  put(
    c,
    `${forge}/${camel(svc)}.ts`,
    `import { action, v } from "@archlast/forge-runtime";
import { inject } from "@archlast/forge-runtime/nest";
import { ${Service} } from "./${svc}.service";

/** Calls ${svc} from a function: \`api.${camel(svc)}.hello\` from a page or a client, or \`ctx.runAction\` from another function. The call is in ${Service}. */
export const hello = action({
  args: { from: v.string() },
  handler: async (ctx, { from }) => (await inject(ctx, ${Service})).hello(from),
});
`,
  );
}

const DEFAULT_HTTP = `import { httpRouter } from "@archlast/forge-runtime";\n\nconst http = httpRouter();\n\nexport default http;\n`;

/**
 * forge/_services.ts in the main app lists the service classes it calls (the controllers and the classes with the clients), and forge/http.ts
 * mounts them with `nest()`. The list is written by the commands that add and remove services, so http.ts is edited once, the first time.
 */
export function writeBarrel(c: Ctx) {
  const { root, ws } = c;
  const forge = forgeRel(ws.main);
  const names = servicesOf(ws).map(([n]) => n);
  if (!names.length && !existsSync(join(root, forge, "_services.ts"))) return;
  put(
    c,
    `${forge}/_services.ts`,
    `// Written by \`archlast-forge add service\` and \`remove\`: the services this app calls, for the nest() call in forge/http.ts. Do not edit it.
${names.map((n) => `import { ${pascal(n)}Controller } from "./${n}.controller";\nimport { ${pascal(n)}Service } from "./${n}.service";`).join("\n")}

export const serviceControllers${names.length ? "" : ": never[]"} = [${names.map((n) => `${pascal(n)}Controller`).join(", ")}];
export const serviceProviders${names.length ? "" : ": never[]"} = [${names.map((n) => `${pascal(n)}Service`).join(", ")}];
`,
  );
  const rel = `${forge}/http.ts`;
  const file = join(root, rel);
  const existed = existsSync(file);
  const current = existed ? readFileSync(file, "utf8") : DEFAULT_HTTP;
  if (current.includes("./_services")) return; // mounted already
  const code = current.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // the template's own comment mentions nest(
  if (/\bnest\(/.test(code)) return void c.notes.push(`${rel} already calls nest(): add ...serviceControllers to its controllers and ...serviceProviders to its providers (import them from "./_services").`);
  if (!current.includes("export default http;")) return void c.notes.push(`Mount the services in ${rel}, before its export: nest(http, { controllers: serviceControllers, providers: serviceProviders }); (import nest from "@archlast/forge-runtime/nest", and both lists from "./_services").`);
  const clean = !existed || isFormatted(root, rel); // a file in someone's own style is left in it
  const mount = `// The services this app calls, as Nest classes: a controller for HTTP clients and a service class that makes the calls (forge/_services.ts lists them).
nest(http, { controllers: serviceControllers, providers: serviceProviders });

`;
  let text = current.replace("export default http;", mount + "export default http;");
  const lastImport = [...text.matchAll(/^import\b[^;]*;$/gm)].at(-1);
  const at = lastImport ? lastImport.index! + lastImport[0].length : 0;
  text = text.slice(0, at) + `\nimport { nest } from "@archlast/forge-runtime/nest";\nimport { serviceControllers, serviceProviders } from "./_services";` + text.slice(at);
  writeFileSync(file, text);
  if (clean) c.written.push(rel);
}

/** What a service's transport needs in the forge/package.json of every backend (Redis's and NATS's client libraries). */
export function ensureTransportPackages(c: Ctx) {
  const needs = TRANSPORT_PACKAGE[c.ws.transport];
  if (!needs || !servicesOf(c.ws).length) return;
  for (const app of backendsOf(c.ws)) patchJson(join(c.root, "apps", app, "forge", "package.json"), (pkg) => void (pkg.dependencies ??= {}, (pkg.dependencies[needs[0]] ??= needs[1])));
}

/** One Forge RPC secret for the backends here: each service checks it, each caller sends it. It is made once, then copied to any backend without it. */
export function ensureToken(c: Ctx) {
  if (c.ws.transport !== "forge-rpc" || !servicesOf(c.ws).length) return;
  const files = backendsOf(c.ws).map((a) => join(c.root, "apps", a, ".env")).filter(existsSync);
  const token = files.map((f) => /^FORGE_RPC_TOKEN=(\S+)$/m.exec(readFileSync(f, "utf8"))?.[1]).find(Boolean) ?? randomBytes(24).toString("hex");
  for (const f of files) if (!/^FORGE_RPC_TOKEN=/m.test(readFileSync(f, "utf8"))) appendFileSync(f, `\n# Forge RPC: the secret the apps of this monorepo share to call each other's routers\nFORGE_RPC_TOKEN=${token}\n`);
}

/** Sets `key` in an .env file, keeping the rest of it: `null` removes it, and with `keep` a value already there stays. */
function setEnv(file: string, key: string, value: string | null, comment: string, keep = false) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const line = new RegExp(`^${key}=.*$`, "m");
  const next =
    value === null
      ? text.replace(new RegExp(`(?:^# .*\\n)?^${key}=.*\\n?`, "m"), "")
      : line.test(text)
        ? keep
          ? text
          : text.replace(line, `${key}=${value}`)
        : `${text.replace(/\n*$/, "\n")}\n# ${comment}\n${key}=${value}\n`;
  if (next !== text) writeFileSync(file, next);
}
const envValue = (file: string, key: string) => (existsSync(file) ? new RegExp(`^${key}=(\\S+)$`, "m").exec(readFileSync(file, "utf8"))?.[1] : undefined);

/**
 * Every app of the monorepo gets a name of its own (OTEL_SERVICE_NAME, which an app that has one keeps). The dashboard shows it, and the engine
 * keys its Redis cache, topics and rate limits by it, so apps that share a Redis stay apart while every server of one app (the same name) shares.
 */
export function ensureAppNames(c: Ctx) {
  for (const name of new Set([c.ws.main, ...Object.keys(c.ws.apps)]))
    setEnv(join(c.root, "apps", name, ".env"), "OTEL_SERVICE_NAME", name, "This app's name: on the dashboard, and in its Redis keys, so apps that share a Redis stay apart", true);
}

/**
 * One dashboard for the monorepo, the main app's: each service sends its telemetry there (DASHBOARD_URL) under its own name, and the main app
 * lists the services (MICROSERVICES) so their data, schema and functions open on it too. The addresses are the development ones (each app on
 * this machine, on its port); production sets its own.
 */
export function ensureDashboard(c: Ctx) {
  ensureAppNames(c);
  const services = servicesOf(c.ws).map(([name]) => name);
  const mainEnv = join(c.root, "apps", c.ws.main, ".env");
  const files = [mainEnv, ...services.map((s) => join(c.root, "apps", s, ".env"))];
  if (!services.length) return setEnv(mainEnv, "MICROSERVICES", null, "");
  const token = files.map((f) => envValue(f, "DASHBOARD_TOKEN")).find(Boolean) ?? randomBytes(24).toString("hex");
  const mainPort = Number(envValue(mainEnv, "PORT")) || 3000;
  setEnv(mainEnv, "OTEL_SERVICE_NAME", c.ws.main, "This app's name on the dashboard", true);
  const listed: string[] = [];
  for (const svc of services) {
    const file = join(c.root, "apps", svc, ".env");
    setEnv(file, "OTEL_SERVICE_NAME", svc, "This service's name on the main app's dashboard, as its MICROSERVICES lists it", true);
    setEnv(file, "DASHBOARD_URL", `http://localhost:${mainPort}`, `Its telemetry goes to the main app (apps/${c.ws.main}), whose dashboard shows it; it serves none of its own`, true);
    listed.push(`${envValue(file, "OTEL_SERVICE_NAME") ?? svc}=http://localhost:${c.ws.apps[svc]!.port}`);
  }
  setEnv(mainEnv, "MICROSERVICES", listed.join(","), "The services whose data, schema and telemetry this app's dashboard shows (name=address)");
  for (const f of files) setEnv(f, "DASHBOARD_TOKEN", token, "The secret the main app and its services share for the dashboard", true);
}

/** A backend main app has to run on this machine in development when it calls services, or its code can't reach their ports. */
export function ensureMainOnHost(c: Ctx) {
  if (modeOf(c.root, c.ws.main) !== "backend" || !servicesOf(c.ws).length) return;
  patchJson(join(c.root, "apps", c.ws.main, "package.json"), (pkg) => {
    const dev: string | undefined = pkg.scripts?.dev;
    if (dev && /^archlast-forge dev\b/.test(dev) && !dev.includes("--no-docker")) pkg.scripts.dev = dev.replace("archlast-forge dev", "archlast-forge dev --no-docker");
  });
}

/** Everything that follows from the services in the workspace: their callers in the main app, the barrel, the transport's packages, the token and the shared packages. */
export function finishServices(c: Ctx, added: string[]) {
  for (const svc of added) writeCaller(c, svc);
  writeBarrel(c);
  ensureTransportPackages(c);
  writeShared(c);
  ensureToken(c);
  ensureDashboard(c);
  ensureMainOnHost(c);
}

/** The TypeScript the monorepo's root pins, which the packages and apps written here use too (a monorepo has one), else the default. */
export const rootTypescript = (root: string): string => (existsSync(join(root, "package.json")) ? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.typescript : undefined) ?? "^7.0.2";
/** The @types/bun the main app uses, else the default: the shared packages type-check its code. */
const typesBun = (c: Ctx): string => JSON.parse(readFileSync(join(c.root, "apps", c.ws.main, "package.json"), "utf8")).devDependencies?.["@types/bun"] ?? "1.4.4";

const TSCONFIG =
  JSON.stringify({ compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, experimentalDecorators: true, types: ["bun"] }, include: ["index.ts"] }, null, 2) + "\n";
/** A shared package: `of` are the apps whose types it re-exports, and `files` are the files of its own it exports besides index.ts (`@<name>/<pkg>/<file>`). */
const sharedPackage = (c: Ctx, pkg: string, of: string[], files: string[] = []) =>
  JSON.stringify(
    {
      name: `@${c.name}/${pkg}`,
      private: true,
      type: "module",
      exports: { ".": "./index.ts", ...Object.fromEntries(files.map((f) => [`./${f}`, `./${f}.ts`])) },
      scripts: { typecheck: "tsc --noEmit" },
      dependencies: { "@archlast/forge-runtime": `^${c.version}` },
      // @types/bun: the apps' code the types come from uses process.env and Bun's globals.
      devDependencies: Object.fromEntries([...of.map((b) => [appPackage(c.root, c.name, b), "workspace:*"]), ["@types/bun", typesBun(c)], ["typescript", rootTypescript(c.root)]]),
    },
    null,
    2,
  ) + "\n";

/**
 * packages/api: the typed API of the main app, and of each other app in a file of its own (`@<name>/api/<app>`). Services are not here: they are
 * called over Forge RPC with packages/contracts. TypeScript holds one backend's schema in a project (each backend's generated types declare
 * the global `Register`), so two backends' types in one project collide, and a project imports the types of one.
 * packages/contracts, for Forge RPC, has the services' types. Both are worked out from the workspace: adding or removing an app writes them again.
 */
export function writeShared(c: Ctx) {
  const { root, ws, name } = c;
  const others = Object.entries(ws.apps).filter(([, a]) => a.kind === "app").map(([n]) => n);
  const services = servicesOf(ws).map(([n]) => n);
  const types = (b: string) => `export { api as ${camel(b)}Api } from "../../apps/${b}/forge/_generated/api";
export type * as ${pascal(b)} from "../../apps/${b}/forge/_generated/dataModel";
`;
  put(c, "packages/api/package.json", sharedPackage(c, "api", [ws.main, ...others], others));
  put(
    c,
    "packages/api/index.ts",
    `// The typed API of the main app (apps/${ws.main}), for what is its client: its pages, a mobile or desktop app. \`archlast-forge codegen\` in the app (its dev
// and typecheck scripts run it) keeps it current. Services are called over Forge RPC, with packages/contracts. Another app's API is in its own
// file, @${name}/api/<app>: TypeScript holds one backend's schema in a project, so a project imports the types of one backend.
${types(ws.main)}`,
  );
  for (const app of others) put(c, `packages/api/${app}.ts`, `// The typed API of apps/${app}, as @${name}/api/${app}. A project imports the types of one backend: see index.ts.\n${types(app)}`);
  for (const f of existsSync(join(root, "packages", "api")) ? readdirSync(join(root, "packages", "api")) : []) {
    // A file of an app that was removed.
    const file = join(root, "packages", "api", f);
    if (/^[a-z0-9-]+\.ts$/.test(f) && f !== "index.ts" && !others.includes(f.slice(0, -3)) && readFileSync(file, "utf8").startsWith("// The typed API of apps/")) rmSync(file);
  }
  put(c, "packages/api/tsconfig.json", TSCONFIG);

  const mainPkg = join(root, "apps", ws.main, "package.json");
  if (ws.transport === "forge-rpc" && services.length) {
    // The services' Forge RPC types, for the backends that call them. Not in packages/api: the main app depends on this, and packages/api on it.
    put(c, "packages/contracts/package.json", sharedPackage(c, "contracts", services));
    put(
      c,
      "packages/contracts/index.ts",
      `// What each service in apps/ serves over Forge RPC, as its codegen writes it (forge/_generated/rpc.ts from its @Router classes):
// \`createForgeRpcClient<OrdersRpc>({ url })\` in the forge/ code of the backend that calls it. Backends only: a page or an app never imports this.
${services.map((s) => `export type { Rpc as ${pascal(s)}Rpc } from "../../apps/${s}/forge/_generated/rpc";`).join("\n")}
`,
    );
    put(c, "packages/contracts/tsconfig.json", TSCONFIG);
    patchJson(mainPkg, (pkg) => void ((pkg.devDependencies ??= {})[`@${name}/contracts`] ??= "workspace:*"));
  } else if (existsSync(join(root, "packages", "contracts"))) {
    rmSync(join(root, "packages", "contracts"), { recursive: true, force: true });
    patchJson(mainPkg, (pkg) => pkg.devDependencies && delete pkg.devDependencies[`@${name}/contracts`]);
  }
}

/** The monorepo's own files: package.json, turbo.json, .gitignore, .prettierignore, the README and the workspace file. */
export function writeRoot(c: Ctx) {
  const { root, name, ws } = c;
  write(
    join(root, "package.json"),
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        packageManager: "bun@1.4.4",
        workspaces: ["apps/*", "packages/*"],
        scripts: { dev: "turbo run dev", build: "turbo run build", typecheck: "turbo run typecheck", format: "prettier --write ." },
        devDependencies: { turbo: "^2.11.10" },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    join(root, "turbo.json"),
    JSON.stringify(
      {
        $schema: "https://turborepo.com/schema.json",
        tasks: {
          dev: { cache: false, persistent: true },
          build: { dependsOn: ["^build"], outputs: [".forge/build/**"] },
          // Each app's typecheck writes forge/_generated first, which packages/api reads.
          typecheck: { dependsOn: ["^typecheck"] },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(join(root, ".gitignore"), "node_modules\n.turbo\n.env\ndist\n.forge\napps/*/data\napps/*/forge/data\n");
  write(join(root, ".prettierignore"), "# Written by archlast-forge codegen\n**/forge/_generated\n");
  write(join(root, "README.md"), readme(c));
  writeWorkspace(root, ws);
  addPrettier(root);
  c.written.push("package.json", "turbo.json", "README.md", WORKSPACE_FILE);
}

/** Writes the monorepo into `dir` and returns its absolute path. */
export function scaffoldMonorepo(o: MonorepoOptions): string {
  const root = resolve(o.dir);
  const name = nameOf(root);
  const version = o.version ?? VERSION;
  const services = o.microservices ?? [];
  const main = o.mode === "framework" ? "web" : "api";
  if (o.desktop === "full" && o.mode !== "framework") throw new Error("--desktop full runs the full-stack app on the user's machine: use --mode framework (or --desktop client for a backend)");

  const ws: Workspace = { main, transport: o.transport ?? "forge-rpc", apps: {} };
  services.forEach((svc, i) => (ws.apps[svc] = { kind: "service", port: 3001 + i, rpcPort: 4001 + i }));
  const c = newCtx(root, name, version, ws);

  // The apps, each a project like `init` makes on its own, then wired.
  scaffold({ dir: join(root, "apps", main), mode: o.mode, services: o.services, shadcn: o.shadcn, version, name: `${name}-${main}` });
  patchJson(join(root, "apps", main, "package.json"), (pkg) => (pkg.name = packageOf(name, main)));
  for (const svc of services) writeService(c, svc);
  finishServices(c, services);

  if (o.mobile) addMobile(c);
  if (o.desktop) addDesktopApp(c, o.desktop);

  writeRoot(c);
  format(root);
  return root;
}

function readmeBody(c: Ctx) {
  const { name, ws } = c;
  const main = ws.main;
  const transport = ws.transport;
  const services = servicesOf(ws).map(([n]) => n);
  const ports = services.map((s) => {
    const a = ws.apps[s]!;
    return `| \`apps/${s}\` | a backend, and the \`${s}\` microservice | http://localhost:${a.port} | ${transport === "forge-rpc" ? `Forge RPC ${a.rpcPort}` : transport === "tcp" ? `TCP ${a.rpcPort}` : transport === "redis" ? "Redis (MICROSERVICES_REDIS_URL)" : "NATS (MICROSERVICES_NATS_URL)"} |`;
  });
  return `# ${name}

A monorepo of [archlast-forge](https://github.com/algochad/archlast-forge) apps, run with [Turborepo](https://turborepo.com).

| Folder | What | In development | Transport |
|---|---|---|---|
| \`apps/${main}\` | the main app${main === "web" ? " (pages and functions)" : " (a backend)"} | http://localhost:3000 | |
${ports.join("\n")}
| \`packages/api\` | the main app's typed API (\`@${name}/api\`; another app's is \`@${name}/api/<app>\`) | | |
${transport === "forge-rpc" && services.length ? `| \`packages/contracts\` | the services' Forge RPC types (\`@${name}/contracts\`) | | |\n` : ""}
\`\`\`bash
bun install
bun run dev         # every app at once (turbo run dev)
bun run typecheck   # codegen, then tsc, in every app and package
\`\`\`
${
  services.length
    ? `
## Services calling services

${
  transport === "forge-rpc"
    ? `Each service in \`apps/\` serves a Forge RPC router (\`forge/<service>.router.ts\`, served from \`forge/http.ts\`). Its codegen writes the router's types to \`forge/_generated/rpc.ts\`, \`packages/contracts\` shares them, and the main app's backend calls each service with them. Forge RPC is backend to backend: pages and apps call the main app, never a service directly.`
    : `Each service in \`apps/\` listens for messages with NestJS's ${TRANSPORT_LABEL[transport]} transport (\`forge/http.ts\`, \`forge/<service>.controller.ts\`), and \`apps/${main}\` sends them messages.`
}

In \`apps/${main}/forge\`, each service has a class that makes the calls (\`${services[0]}.service.ts\`), and two ways in that both use it: a Nest controller (\`${services[0]}.controller.ts\`, mounted in \`http.ts\` through \`_services.ts\`) and an action (\`${camel(services[0]!)}.ts\`, which gets the class with \`inject(ctx, ${pascal(services[0]!)}Service)\`):

\`\`\`bash
curl -X POST localhost:3000/rpc/${camel(services[0]!)}:hello -H 'content-type: application/json' -d '{"from":"${main}"}'   # the action
# {"result":{"service":"${services[0]}","greeting":"Hello, ${main}","calls":1}}
curl -X POST localhost:3000/http/${services[0]}/hello -H 'content-type: application/json' -d '{"from":"${main}"}'  # the controller
# {"service":"${services[0]}","greeting":"Hello, ${main}","calls":2}
\`\`\`
${transport === "forge-rpc" ? `\nIn development every app runs on this machine (\`--no-docker\`), so the services' ports are reachable, and the apps share \`FORGE_RPC_TOKEN\` from their \`.env\`. In production, give every app the same \`FORGE_RPC_TOKEN\`, the callers \`<SERVICE>_RPC_URL\`, and expose each service's Forge RPC port to them (one network for the stacks).` : transport === "tcp" ? `\nIn development every app runs on this machine (\`--no-docker\`), so the TCP ports are reachable. In production, set \`<SERVICE>_HOST\` and \`<SERVICE>_PORT\` for the callers, and expose each service's TCP port to them (one network for the stacks).` : `\nStart a ${transport === "redis" ? "Redis" : "NATS"} server first, and point every app at it with \`${transport === "redis" ? "MICROSERVICES_REDIS_URL" : "MICROSERVICES_NATS_URL"}\` in production.`}

## One dashboard

The main app's dashboard (http://localhost:3000/_dashboard) shows every service: their requests, traces, errors, logs, nodes and Nest classes beside the main app's, and, with a service picked at the top, its data, schema and functions. Each service sends its telemetry to the main app (\`DASHBOARD_URL\` and \`OTEL_SERVICE_NAME\` in its \`.env\`) and serves no dashboard of its own; the main app lists the services (\`MICROSERVICES\`), and they share \`DASHBOARD_TOKEN\`. In production set the same with the addresses the apps reach each other at.
`
    : ""
}`;
}

const CHANGING = `
## Changing it

\`archlast-forge\` changes the monorepo from any folder of it, and installs what the change needs:

\`\`\`bash
archlast-forge add service billing     # a microservice: its app, its router, and a class in the main app that calls it
archlast-forge add app admin           # another full-stack app (--mode backend for a backend)
archlast-forge add mobile              # an Expo app, a client of the main app
archlast-forge add desktop client      # a Tauri app (full or client)
archlast-forge remove billing          # an app or a service (and the main app's calls to it), or the mobile or desktop app
archlast-forge workspace               # what is here and on which ports; \`workspace sync\` rewrites packages/api and packages/contracts
archlast-forge stack add redis         # postgres, redis, s3 or caddy in the compose.yaml of the app you are in
\`\`\`

\`archlast-forge.workspace.json\` records the ports and how the services talk.
`;

function readme(c: Ctx) {
  return readmeBody(c) + CHANGING;
}

/**
 * apps/mobile: the Expo app (template/mobile), a client of the main app, and what the main app needs for it: Better Auth's Expo plugin, which
 * lets the app's scheme sign in and keeps sessions working without browser cookies. A main app with an auth.ts of its own keeps it, and is told what to add.
 */
export function addMobile(c: Ctx) {
  const { root, name, version } = c;
  const dir = join(root, "apps", "mobile");
  cpSync(MOBILE, dir, { recursive: true });
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore")); // npm drops .gitignore files from packages
  renameSync(join(dir, "env.example"), join(dir, ".env.example"));
  const fill = (path: string) => {
    for (const entry of readdirSync(path)) {
      const p = join(path, entry);
      if (statSync(p).isDirectory()) fill(p);
      else writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__API__", `${camel(c.ws.main)}Api`).replaceAll("__MAIN__", c.ws.main).replaceAll("__VERSION__", version));
    }
  };
  fill(dir);
  writeFileSync(join(dir, ".env"), readFileSync(join(dir, ".env.example"), "utf8"));
  patchJson(join(dir, "package.json"), (pkg) => (pkg.devDependencies.typescript = rootTypescript(root)));
  c.written.push("apps/mobile");
  const forge = join(root, "apps", c.ws.main, "forge");
  if (existsSync(join(forge, "auth.ts")))
    c.notes.push(`apps/${c.ws.main}/forge/auth.ts is yours, so it is unchanged. For the mobile app to sign in, add plugins: [expo()] (import { expo } from "@better-auth/expo") and trustedOrigins: ["${name}://"] to its defineAuth options.`);
  else
    put(
      c,
      `apps/${c.ws.main}/forge/auth.ts`,
      `import { defineAuth } from "@archlast/forge-runtime";
import { expo } from "@better-auth/expo";

// The mobile app signs in through Better Auth's Expo plugin: its requests come from its scheme (${name}://), not from a web origin.
export default defineAuth({ emailAndPassword: { enabled: true }, plugins: [expo()], trustedOrigins: ["${name}://"] });
`,
    );
  patchJson(join(forge, "package.json"), (pkg) => (pkg.dependencies = { ...pkg.dependencies, "@better-auth/expo": "1.7.12" }));
  c.ws.mobile = true;
}

/** apps/desktop: the Tauri app, the full-stack app with its engine on the user's machine, or a client of a backend. */
export function addDesktopApp(c: Ctx, mode: DesktopMode) {
  addDesktop(c.root, c.name, c.version, mode, c.ws.main, modeOf(c.root, c.ws.main));
  c.written.push("apps/desktop");
  c.ws.desktop = mode;
}
