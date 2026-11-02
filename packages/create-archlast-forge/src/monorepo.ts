// A Turborepo monorepo: the main app in apps/, backends that serve as microservices beside it, wired with a NestJS transport, and the
// backends' generated API types shared from packages/api.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nameOf } from "./options";
import { addPrettier, format, scaffold, VERSION } from "./scaffold";
import type { BaseColor } from "./shadcn";
import type { Mode, StackService } from "./stack";

export const TRANSPORTS = ["tcp", "redis", "nats"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface MonorepoOptions {
  dir: string;
  mode: Mode;
  services: StackService[];
  shadcn?: BaseColor;
  /** Backends to add as microservices, by name (`orders`, `billing`). */
  microservices?: string[];
  transport?: Transport;
  /** A React Native (Expo) app in apps/mobile, a client of the backend (the main app must be one: Expo has no full-stack option). */
  mobile?: boolean;
  version?: string;
}

const MOBILE = new URL("../template/mobile", import.meta.url).pathname;

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export function parseMicroservices(text: string): string[] {
  const names = text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const n of names) if (!SERVICE_NAME.test(n)) throw new Error(`"${n}" isn't a service name: lowercase letters, digits and "-", starting with a letter`);
  for (const n of names) if (["web", "api", "mobile", "desktop"].includes(n)) throw new Error(`"${n}" is taken by the monorepo's own apps; pick another name`);
  if (new Set(names).size !== names.length) throw new Error("A service is named twice");
  return names;
}

const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s)[0]!.toUpperCase() + camel(s).slice(1);
const env = (s: string) => s.toUpperCase().replace(/-/g, "_");

/** How a client reaches microservice `name` (the `index`-th) over `transport`, as Nest's options, read from the environment with local defaults. */
function transportOptions(transport: Transport, name: string, index: number, listen: boolean) {
  if (transport === "tcp")
    return `{ transport: Transport.TCP, options: { host: process.env.${env(name)}_HOST ?? "${listen ? "0.0.0.0" : "127.0.0.1"}", port: Number(process.env.${env(name)}_PORT ?? ${4001 + index}) } }`;
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
/** The client package a transport needs in forge/package.json (TCP needs none). */
const TRANSPORT_PACKAGE: Record<Transport, [string, string] | undefined> = { tcp: undefined, redis: ["ioredis", "^5.6.1"], nats: ["nats", "^2.29.3"] };

const write = (path: string, text: string) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, text));
const patchJson = (path: string, change: (json: any) => void) => {
  const json = JSON.parse(readFileSync(path, "utf8"));
  change(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
};

/** Writes the monorepo into `dir` and returns its absolute path. */
export function scaffoldMonorepo(o: MonorepoOptions): string {
  const root = resolve(o.dir);
  const name = nameOf(root);
  const version = o.version ?? VERSION;
  const transport = o.transport ?? "tcp";
  const services = o.microservices ?? [];
  const main = o.mode === "framework" ? "web" : "api";
  if (o.mobile && o.mode !== "backend") throw new Error("The Expo app is a client of a backend: use --mode backend (Expo has no full-stack option)");

  // The apps, each a project like `init` makes on its own, then wired.
  scaffold({ dir: join(root, "apps", main), mode: o.mode, services: o.services, shadcn: o.shadcn, version });
  for (const svc of services) scaffold({ dir: join(root, "apps", svc), mode: "backend", services: [], version });
  const backends = [main, ...services];

  // Each runs on its own port in development (the main app keeps 3000), on this machine, so the transports' ports are reachable.
  patchJson(join(root, "apps", main, "package.json"), (pkg) => (pkg.name = `@${name}/${main}`));
  services.forEach((svc, i) =>
    patchJson(join(root, "apps", svc, "package.json"), (pkg) => {
      pkg.name = `@${name}/${svc}`;
      pkg.scripts.dev = `archlast-forge dev --no-docker --port ${3001 + i}`;
    }),
  );

  for (const [i, svc] of services.entries()) {
    const forge = join(root, "apps", svc, "forge");
    // The service: a message pattern that does its own work (a mutation in its own database) and answers.
    writeFileSync(
      join(forge, "schema.ts"),
      readFileSync(join(forge, "schema.ts"), "utf8").replace("export default defineSchema({\n", "export default defineSchema({\n  calls: defineTable({ from: v.string(), at: v.number() }),\n"),
    );
    write(
      join(forge, "calls.ts"),
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
    write(
      join(forge, `${svc}.controller.ts`),
      `import { internal } from "./_generated/api";
import { Controller, type ActionCtx } from "@archlast/forge-runtime/nest";
import { Ctx, MessagePattern, Payload } from "@archlast/forge-runtime/nest/microservices";

/** What ${svc} answers over the ${transport.toUpperCase()} transport. Other services call it with \`send("${svc}.hello", { from })\`. */
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
    write(
      join(forge, "http.ts"),
      `import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { Transport } from "@archlast/forge-runtime/nest/microservices";
import { ${pascal(svc)}Controller } from "./${svc}.controller";
${transport === "redis" ? REDIS_HELPER : ""}
const http = httpRouter();
http.route({ method: "GET", path: "/hello", handler: httpAction(async () => Response.json({ message: "Hello from ${svc}" })) });

// ${svc} listens for other services' messages here, in the engine's first function runtime process.
nest(http, { controllers: [${pascal(svc)}Controller], microservices: [${transportOptions(transport, svc, i, true)}] });

export default http;
`,
    );
  }

  // The caller: one action per service in the main app, sending it a message and returning the answer.
  for (const [i, svc] of services.entries())
    write(
      join(root, "apps", main, "forge", `${camel(svc)}.ts`),
      `import { action, v } from "@archlast/forge-runtime";
import { rxjs } from "@archlast/forge-runtime/nest";
import { ClientProxyFactory, Transport } from "@archlast/forge-runtime/nest/microservices";
${transport === "redis" ? REDIS_HELPER : ""}
/** The ${svc} service, over ${transport.toUpperCase()}: connected on first use, kept for every call after. */
const ${camel(svc)} = ClientProxyFactory.create(${transportOptions(transport, svc, i, false)});

/** Calls ${svc}: \`api.${camel(svc)}.hello\` from a page or a client, or \`ctx.runAction\` from another function. */
export const hello = action({
  args: { from: v.string() },
  handler: (_ctx, args) => rxjs.firstValueFrom(${camel(svc)}.send<{ service: string; greeting: string; calls: number }>("${svc}.hello", args)),
});
`,
    );
  const needs = TRANSPORT_PACKAGE[transport];
  if (needs && services.length)
    for (const app of backends) patchJson(join(root, "apps", app, "forge", "package.json"), (pkg) => (pkg.dependencies = { ...pkg.dependencies, [needs[0]]: needs[1] }));

  if (o.mobile) addMobile(root, name, version);

  // The backends' typed APIs, for any app or package here: \`import { webApi } from "@<name>/api"\`.
  write(
    join(root, "packages", "api", "package.json"),
    JSON.stringify(
      {
        name: `@${name}/api`,
        private: true,
        type: "module",
        exports: { ".": "./index.ts" },
        scripts: { typecheck: "tsc --noEmit" },
        dependencies: { "@archlast/forge-runtime": `^${version}` },
        devDependencies: Object.fromEntries([...backends.map((b) => [`@${name}/${b}`, "workspace:*"]), ["typescript", "^7.0.2"]]),
      },
      null,
      2,
    ) + "\n",
  );
  write(
    join(root, "packages", "api", "index.ts"),
    `// The typed APIs of the backends in apps/, for any app or package of this monorepo. \`archlast-forge codegen\` in each app (its dev and
// typecheck scripts run it) keeps them current.
${backends.map((b) => `export { api as ${camel(b)}Api } from "../../apps/${b}/forge/_generated/api";`).join("\n")}
${backends.map((b) => `export type * as ${pascal(b)} from "../../apps/${b}/forge/_generated/dataModel";`).join("\n")}
`,
  );
  write(
    join(root, "packages", "api", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, experimentalDecorators: true }, include: ["index.ts"] }, null, 2) + "\n",
  );

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
  write(join(root, "README.md"), readme(name, main, services, transport));
  addPrettier(root);
  format(root);
  return root;
}

function readme(name: string, main: string, services: string[], transport: Transport) {
  const ports = services.map((s, i) => `| \`apps/${s}\` | a backend, and the \`${s}\` microservice | http://localhost:${3001 + i} | ${transport === "tcp" ? `TCP ${4001 + i}` : transport === "redis" ? "Redis (MICROSERVICES_REDIS_URL)" : "NATS (MICROSERVICES_NATS_URL)"} |`);
  return `# ${name}

A monorepo of [archlast-forge](https://github.com/algochad/archlast-forge) apps, run with [Turborepo](https://turborepo.com).

| Folder | What | In development | Transport |
|---|---|---|---|
| \`apps/${main}\` | the main app${main === "web" ? " (pages and functions)" : " (a backend)"} | http://localhost:3000 | |
${ports.join("\n")}
| \`packages/api\` | the backends' typed APIs (\`@${name}/api\`) | | |

\`\`\`bash
bun install
bun run dev         # every app at once (turbo run dev)
bun run typecheck   # codegen, then tsc, in every app and package
\`\`\`
${
  services.length
    ? `
## Services calling services

Each service in \`apps/\` listens for messages with NestJS's ${transport.toUpperCase()} transport (\`forge/http.ts\`, \`forge/<service>.controller.ts\`), and \`apps/${main}\` calls them with an action each (\`forge/${camel(services[0]!)}.ts\`):

\`\`\`bash
curl -X POST localhost:3000/rpc/${camel(services[0]!)}:hello -H 'content-type: application/json' -d '{"from":"${main}"}'
# {"result":{"service":"${services[0]}","greeting":"Hello, ${main}","calls":1}}
\`\`\`
${transport === "tcp" ? `\nIn development every app runs on this machine (\`--no-docker\`), so the TCP ports are reachable. In production, set \`<SERVICE>_HOST\` and \`<SERVICE>_PORT\` for the callers, and expose each service's TCP port to them (one network for the stacks).` : `\nStart a ${transport === "redis" ? "Redis" : "NATS"} server first, and point every app at it with \`${transport === "redis" ? "MICROSERVICES_REDIS_URL" : "MICROSERVICES_NATS_URL"}\` in production.`}
`
    : ""
}`;
}

/**
 * apps/mobile: the Expo app (template/mobile), and what the backend in apps/api needs for it: Better Auth's Expo plugin, which lets the app's
 * scheme sign in and keeps sessions working without browser cookies.
 */
function addMobile(root: string, name: string, version: string) {
  const dir = join(root, "apps", "mobile");
  cpSync(MOBILE, dir, { recursive: true });
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore")); // npm drops .gitignore files from packages
  renameSync(join(dir, "env.example"), join(dir, ".env.example"));
  const fill = (path: string) => {
    for (const entry of readdirSync(path)) {
      const p = join(path, entry);
      if (statSync(p).isDirectory()) fill(p);
      else writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__VERSION__", version));
    }
  };
  fill(dir);
  writeFileSync(join(dir, ".env"), readFileSync(join(dir, ".env.example"), "utf8"));
  const forge = join(root, "apps", "api", "forge");
  write(
    join(forge, "auth.ts"),
    `import { defineAuth } from "@archlast/forge-runtime";
import { expo } from "@better-auth/expo";

// The mobile app signs in through Better Auth's Expo plugin: its requests come from its scheme (${name}://), not from a web origin.
export default defineAuth({ emailAndPassword: { enabled: true }, plugins: [expo()], trustedOrigins: ["${name}://"] });
`,
  );
  patchJson(join(forge, "package.json"), (pkg) => (pkg.dependencies = { ...pkg.dependencies, "@better-auth/expo": "1.7.12" }));
}

/** Whether `dir` looks like a monorepo this scaffolder made (for tests and the CLI). */
export const isMonorepo = (dir: string) => existsSync(join(dir, "turbo.json")) && existsSync(join(dir, "packages", "api"));
