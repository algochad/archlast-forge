#!/usr/bin/env bun
// End to end in Docker: scaffolds both kinds of project from the packed tarballs, brings each stack up with `archlast-forge up`,
// and checks what a user would: pages, the API, the database, Redis, uploads, a restart, and `down`.
//   bun scripts/pack.ts && bun scripts/e2e-docker.ts [plain|framework|backend|nest|monorepo|caddy]
//   bun scripts/e2e-docker.ts nest --no-docker   (the NestJS checks on SQLite, served by `start --no-docker`, where there is no Docker)
// Needs Docker and the engine image (`bun packages/cli/src/index.ts engine build`).
import { call, check, createMonorepo, createProject, json, sh, signUp, type MonorepoApp } from "./lib/e2e";

/** A full-stack app with `--services none`, so SQLite on a volume. */
async function plain() {
  console.log("\nFull-stack app with nothing else (SQLite)");
  const p = createProject("e2e-plain", "framework", [], 3104, 9104);
  try {
    const up = p.cli("up");
    check("`archlast-forge up` starts a single container", up.ok && p.compose("ps", "-q").out.split("\n").length === 1, up.err || up.out);
    const cookie = await signUp(p.base, "lite@example.com", "Lite");
    await call(p.base, "messages:send", { body: "kept in sqlite" }, cookie);
    check("the chat page has the message", (await (await fetch(`${p.base}/chat`, { headers: { cookie } })).text()).includes("kept in sqlite"));
    p.compose("restart", "app");
    for (let i = 0; i < 60 && !(await fetch(`${p.base}/ready`).then((r) => r.ok, () => false)); i++) await Bun.sleep(1000);
    check("the message and the session survive a restart (the volume)", (await (await fetch(`${p.base}/chat`, { headers: { cookie } })).text()).includes("kept in sqlite"));
    check("`down` removes the container", p.cli("down").ok && (p.compose("ps", "-q").out || "") === "");
    const again = p.cli("up");
    check("`up` after `down` finds the data again", again.ok && (await (await fetch(`${p.base}/chat`, { headers: { cookie } })).text()).includes("kept in sqlite"), again.err);
  } finally {
    p.cli("down", "--volumes");
  }
}

async function framework() {
  console.log("\nFull-stack app with PostgreSQL");
  const p = createProject("e2e-fullstack", "framework", ["postgres"], 3101, 9101);
  try {
    const up = p.cli("up");
    check("`archlast-forge up` builds and starts the stack", up.ok, up.err || up.out);
    check("it prints where the app is", up.out.includes(p.base) && up.out.includes("/_dashboard"), up.out);

    const home = await (await fetch(`${p.base}/`)).text();
    check("the home page is server-rendered", home.includes("<html") && home.includes("Realtime. Full-stack. One deploy."));
    const entry = /src="(\/_app\/[^"]+\.js)"/.exec(home)?.[1];
    const script = await fetch(`${p.base}${entry}`, { headers: { "accept-encoding": "br" } });
    check("its script is served compressed and cacheable", script.ok && script.headers.get("content-encoding") === "br" && script.headers.get("cache-control")!.includes("immutable"), [...script.headers]);
    check("the dashboard is there", (await fetch(`${p.base}/_dashboard`)).ok);
    check("ready and healthy", (await fetch(`${p.base}/ready`)).ok);

    const cookie = await signUp(p.base, "ada@example.com", "Ada");
    const sent = await call(p.base, "messages:send", { body: "hello from the container" }, cookie);
    check("a signed-in user can send a message", typeof sent.result === "string", sent);
    const chat = await (await fetch(`${p.base}/chat`, { headers: { cookie } })).text();
    check("/chat arrives with the message already in it", chat.includes("hello from the container") && chat.includes("Ada"));
    check("an anonymous visitor to /chat is sent to sign in", (await fetch(`${p.base}/chat`, { redirect: "manual" })).headers.get("location") === "/sign-in");

    const tables = p.compose("exec", "-T", "postgres", "psql", "-U", "forge", "-d", "forge", "-c", "\\dt");
    check("the data is in PostgreSQL", tables.ok && tables.out.includes("messages"), tables.out || tables.err);

    p.compose("restart", "app");
    for (let i = 0; i < 60 && !(await fetch(`${p.base}/ready`).then((r) => r.ok, () => false)); i++) await Bun.sleep(1000);
    check("the message survives a restart", (await (await fetch(`${p.base}/chat`, { headers: { cookie } })).text()).includes("hello from the container"));

    const status = p.cli("status");
    check("`status` lists the containers", status.ok && status.out.includes("app") && status.out.includes("postgres"), status.out || status.err);
    const down = p.cli("down");
    check("`down` stops them", down.ok, down.err);
    check("and they're gone", (p.compose("ps", "-q").out || "") === "");
  } finally {
    p.cli("down", "--volumes");
  }
}

async function backend() {
  console.log("\nBackend with PostgreSQL, Redis and S3 storage");
  const p = createProject("e2e-backend", "backend", ["postgres", "redis", "s3"], 3102, 9102);
  try {
    const up = p.cli("up");
    check("`archlast-forge up` starts the whole stack", up.ok, up.err || up.out);
    const ps = p.compose("ps", "--format", "{{.Service}} {{.Status}}").out;
    for (const svc of ["app", "postgres", "redis", "rustfs"]) check(`${svc} is running`, ps.includes(`${svc} Up`), ps);

    check("the backend answers", (await json(await fetch(`${p.base}/http/hello`))).message.startsWith("Hello from"));
    check("there is no web app, just the API", (await fetch(`${p.base}/`)).status === 404);

    const cookie = await signUp(p.base, "grace@example.com", "Grace");
    check("a message can be sent and read back", typeof (await call(p.base, "messages:send", { body: "stored in postgres" }, cookie)).result === "string");
    const list = await json(await fetch(`${p.base}/rpc/messages:list?args=${encodeURIComponent(JSON.stringify({ paginationOpts: { numItems: 5, cursor: null } }))}`));
    check("through the live query API", list.result.page[0].body === "stored in postgres", list);

    const redis = p.compose("exec", "-T", "redis", "redis-cli", "client", "list");
    check("the app is connected to Redis", redis.ok && redis.out.split("\n").length >= 2, redis.out || redis.err);

    const slot = await call(p.base, "files:generateUploadUrl", { contentType: "text/plain" }, cookie);
    check("an upload URL points at the published storage", slot.result?.uploadUrl?.startsWith(`http://localhost:${p.s3Port}/`), slot);
    const put = await fetch(slot.result.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "file contents" });
    check("a file can be uploaded to it", put.ok, `${put.status} ${await put.text()}`);
    const link = await call(p.base, "files:url", { storageId: slot.result.storageId }, cookie);
    check("and downloaded again through a presigned link", (await (await fetch(link.result)).text()) === "file contents", link);
    check("anonymous users can't get upload URLs", (await call(p.base, "files:generateUploadUrl", {})).error?.message === "Sign in to upload files");

    p.compose("restart", "app");
    for (let i = 0; i < 60 && !(await fetch(`${p.base}/ready`).then((r) => r.ok, () => false)); i++) await Bun.sleep(1000);
    const again = await json(await fetch(`${p.base}/rpc/messages:list?args=${encodeURIComponent(JSON.stringify({ paginationOpts: { numItems: 5, cursor: null } }))}`));
    check("data survives a restart", again.result.page[0]?.body === "stored in postgres");

    const down = p.cli("down", "--volumes");
    check("`down --volumes` removes the stack and its data", down.ok && (p.compose("ps", "-a", "-q").out || "") === "", down.err);
  } finally {
    p.cli("down", "--volumes");
  }
}

/** Needs ports 80 and 443 on this machine, so it runs only when asked: `bun scripts/e2e-docker.ts caddy`. */
async function caddy() {
  console.log("\nFull-stack app with the default stack: PostgreSQL, Redis, S3 storage and Caddy (HTTPS)");
  const p = createProject("e2e-caddy", "framework", ["postgres", "redis", "s3", "caddy"], 3103, 9103);
  const https = (path: string, init: RequestInit = {}) => fetch(`https://localhost${path}`, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);
  try {
    const up = p.cli("up");
    check("`archlast-forge up` starts the app, its services and Caddy", up.ok, up.err || up.out);
    check("the app itself is not published", sh(["docker", "ps", "--format", "{{.Ports}}", "--filter", "name=e2e-caddy-app"], p.dir).out.includes("->") === false);

    const home = await https("/", { headers: { "accept-encoding": "gzip" } });
    const html = await home.text();
    check("the page is served over HTTPS", home.ok && html.includes("Realtime. Full-stack. One deploy."), home.status);
    check("Caddy compresses it", ["gzip", "zstd"].includes(home.headers.get("content-encoding") ?? ""), [...home.headers]);
    const plain = await fetch("http://localhost/", { redirect: "manual" });
    check("plain HTTP is sent to HTTPS", plain.status >= 300 && plain.status < 400 && (plain.headers.get("location") ?? "").startsWith("https://"), plain.status);

    const base = "https://localhost";
    const res = await https("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: "tls@example.com", password: "correct horse battery", name: "Tls" }) });
    check("signing up works behind the proxy, over TLS", res.ok, `${res.status} ${await res.text()}`);
    check("with a Secure session cookie", res.headers.getSetCookie().some((c) => /secure/i.test(c)), res.headers.getSetCookie());
  } finally {
    p.cli("down", "--volumes");
  }
}

/** NestJS in a backend on PostgreSQL, built into the image: controllers, services, CORS, Express writes, SSE, a gateway, GraphQL and a microservice. */
async function nest() {
  // `nest --no-docker`: the same checks on SQLite, served by `archlast-forge start --no-docker`, for a machine without Docker.
  const local = process.argv.includes("--no-docker");
  console.log(`\nBackend with NestJS on ${local ? "SQLite, without Docker" : "PostgreSQL"}`);
  const p = createProject("e2e-nest", "backend", local ? [] : ["postgres"], 3105, 9105);
  let server: ReturnType<typeof Bun.spawn> | undefined;
  const forge = (file: string, text: string) => Bun.write(`${p.dir}/forge/${file}`, text);
  await forge("schema.ts", (await Bun.file(`${p.dir}/forge/schema.ts`).text()).replace("export default defineSchema({", "export default defineSchema({\n  notes: defineTable({ text: v.string() }),"));
  await forge(
    "notes.service.ts",
    `import { ForgeService, Injectable, type MutationCtx, type QueryCtx } from "@archlast/forge-runtime/nest";
@Injectable()
export class NotesReader extends ForgeService<QueryCtx> {
  list() { return this.ctx.db.query("notes").collect(); }
}
@Injectable()
export class NotesWriter extends ForgeService<MutationCtx> {
  add(text: string) { return this.ctx.db.insert("notes", { text }); }
}
`,
  );
  await forge(
    "notes.ts",
    `import { mutation, query, v } from "@archlast/forge-runtime";
import { inject } from "@archlast/forge-runtime/nest";
import { NotesReader, NotesWriter } from "./notes.service";
export const list = query({ args: {}, handler: async (ctx) => (await inject(ctx, NotesReader)).list() });
export const add = mutation({ args: { text: v.string() }, handler: async (ctx, { text }) => (await inject(ctx, NotesWriter)).add(text) });
`,
  );
  await forge(
    "notes.nest.ts",
    `import { Body, Controller, Ctx, Get, Post, Res, Sse, rxjs, type ActionCtx, type NestResponse } from "@archlast/forge-runtime/nest";
import { createPubSub, Field, Mutation, ObjectType, Query, Resolver, Subscription, Args } from "@archlast/forge-runtime/nest/graphql";
import { MessagePattern, Payload } from "@archlast/forge-runtime/nest/microservices";
import { MessageBody, SubscribeMessage, WebSocketGateway } from "@archlast/forge-runtime/nest/websockets";
import { api } from "./_generated/api";

const pubSub = createPubSub<{ noteAdded: { text: string } }>();

@Controller("notes")
export class NotesController {
  @Get() list(@Ctx() ctx: ActionCtx) { return ctx.runQuery(api.notes.list); }
  @Post() async add(@Ctx() ctx: ActionCtx, @Body() body: { text: string }) { return { id: await ctx.runMutation(api.notes.add, { text: body.text }) }; }
  @Get("express") express(@Res() res: NestResponse) { res.status(202).cookie("seen", "yes", { httpOnly: true }).json({ express: true }); }
  @Sse("ticks") ticks() { return rxjs.interval(10).pipe(rxjs.take(2), rxjs.map((i) => ({ data: { i } }))); }
  @MessagePattern("sum") sum(@Payload() numbers: number[]) { return numbers.reduce((a, b) => a + b, 0); }
}

@WebSocketGateway({ path: "/ws" })
export class Gateway {
  @SubscribeMessage("count") async count(@Ctx() ctx: ActionCtx) { return { event: "count", data: (await ctx.runQuery(api.notes.list)).length }; }
}

@ObjectType() class Note { @Field() text!: string; }

@Resolver(() => Note)
export class NotesResolver {
  @Query(() => [Note]) notes(@Ctx() ctx: ActionCtx) { return ctx.runQuery(api.notes.list); }
  @Mutation(() => String) async addNote(@Ctx() ctx: ActionCtx, @Args("text") text: string) {
    const id = await ctx.runMutation(api.notes.add, { text });
    pubSub.publish("noteAdded", { text });
    return id;
  }
  @Subscription(() => Note, { resolve: (n: Note) => n }) noteAdded() { return pubSub.subscribe("noteAdded"); }
}
`,
  );
  const http = `${p.dir}/forge/http.ts`;
  await Bun.write(
    http,
    (await Bun.file(http).text())
      .replace(
        `import { httpAction, httpRouter } from "@archlast/forge-runtime";`,
        `import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { ForgeGraphQLDriver, GraphQLModule, type ForgeGraphQLOptions } from "@archlast/forge-runtime/nest/graphql";
import { Transport } from "@archlast/forge-runtime/nest/microservices";
import { Gateway, NotesController, NotesResolver } from "./notes.nest";
import { NotesReader, NotesWriter } from "./notes.service";`,
      )
      .replace(
        "export default http;",
        `nest(http, {
  imports: [GraphQLModule.forRoot<ForgeGraphQLOptions>({ driver: ForgeGraphQLDriver, autoSchemaFile: true, yoga: { graphiql: false } })],
  controllers: [NotesController],
  providers: [NotesReader, NotesWriter, Gateway, NotesResolver],
  cors: { origin: "https://app.example" },
  microservices: [{ transport: Transport.TCP, options: { host: "0.0.0.0", port: 4000 } }],
});
export default http;`,
      ),
  );
  try {
    const codegen = p.cli("codegen");
    check("codegen takes the Nest files", codegen.ok, codegen.err || codegen.out);
    if (local) {
      server = Bun.spawn(["bunx", "archlast-forge", "start", "--no-docker"], { cwd: p.dir, env: { ...process.env, ARCHLAST_NO_DOCKER: "1", DATA_DIR: `${p.dir}/data` }, stdout: "inherit", stderr: "inherit" });
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) (await Bun.sleep(500), (ready = await fetch(`${p.base}/ready`).then((r) => r.ok, () => false)));
      check("`archlast-forge start --no-docker` serves the backend with Nest", ready);
    } else {
      const up = p.cli("up");
      check("`archlast-forge up` builds the image with Nest in it and starts the stack", up.ok, up.err || up.out);
    }

    const at = (path: string, init?: RequestInit) => fetch(`${p.base}/http${path}`, init);
    const created = await at("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "in postgres" }) });
    check(`a controller writes through a service into ${local ? "SQLite" : "PostgreSQL"}`, created.status === 201, `${created.status} ${await created.clone().text()}`);
    check("and reads it back", ((await (await at("/notes")).json()) as any[]).some((n) => n.text === "in postgres"));
    const pre = await at("/notes", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    check("CORS answers a preflight", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "https://app.example", pre.status);
    const express = await at("/notes/express");
    check("an Express-style response keeps its status and cookie", express.status === 202 && /seen=yes/.test(express.headers.get("set-cookie") ?? ""), [...express.headers]);
    const sse = await (await at("/notes/ticks")).text();
    check("server-sent events stream", sse.includes('data: {"i":1}'), sse);

    const socket = new WebSocket(`ws://localhost:${p.port}/http/ws`);
    const count = await new Promise<any>((resolve) => {
      socket.onopen = () => socket.send(JSON.stringify({ event: "count" }));
      socket.onmessage = (e) => resolve(JSON.parse(String(e.data)));
      setTimeout(() => resolve("no answer"), 10_000);
    });
    socket.close();
    check("a gateway answers over the engine's socket, with the ctx", count?.event === "count" && count.data >= 1, count);

    const subscription = new WebSocket(`ws://localhost:${p.port}/http/graphql`, "graphql-transport-ws");
    const pushed = new Promise<any>((resolve) => {
      subscription.onopen = () => subscription.send(JSON.stringify({ type: "connection_init" }));
      subscription.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "connection_ack") subscription.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: "subscription { noteAdded { text } }" } }));
        if (m.type === "next") resolve(m.payload.data);
      };
      setTimeout(() => resolve("no event"), 15_000);
    });
    await Bun.sleep(500);
    const gql = async (query: string) => (await (await at("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).json()) as any;
    check("a GraphQL mutation runs", typeof (await gql('mutation { addNote(text: "from graphql") }')).data?.addNote === "string");
    check("a GraphQL query reads", (await gql("{ notes { text } }")).data?.notes?.some((n: any) => n.text === "from graphql"));
    const event = await pushed;
    subscription.close();
    check("a GraphQL subscription gets the event over graphql-ws", event?.noteAdded?.text === "from graphql", event);

    const client = `const { ClientProxyFactory, Transport } = await import("@archlast/forge-runtime/nest/microservices"); const { rxjs } = await import("@archlast/forge-runtime/nest");
const c = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: "127.0.0.1", port: 4000 } }); console.log(await rxjs.firstValueFrom(c.send("sum", [1, 2, 3]))); await c.close(); process.exit(0);`;
    const sum = local ? sh(["bun", "-e", client], `${p.dir}/forge`) : p.compose("exec", "-T", "-w", "/app/forge", "app", "bun", "-e", client);
    check(`the TCP microservice answers${local ? "" : " inside the container"}`, sum.ok && sum.out.trim().endsWith("6"), sum.err || sum.out);
  } finally {
    if (server) (server.kill(), await server.exited);
    else p.cli("down", "--volumes");
  }
}

/** A monorepo, built and started as its README says: `up` in each app, whose stacks find each other on the monorepo's Docker network. */
async function monorepo() {
  console.log("\nMonorepo: a full-stack app on PostgreSQL calling a service over Forge RPC, each in its own stack");
  const m = createMonorepo("e2e-shop", "framework", ["postgres"], ["orders"], { web: 3105, orders: 3106 });
  const { web, orders } = m.apps as Record<"web" | "orders", MonorepoApp>;
  try {
    const build = orders.cli("build", "--tag", "e2e-shop-orders:latest");
    check("`build` installs forge/'s dependencies on a fresh clone and builds the service", build.ok, build.err || build.out);
    for (const [name, app] of [["orders", orders], ["web", web]] as const) {
      const up = app.cli("up");
      check(`\`archlast-forge up\` in apps/${name} starts its stack`, up.ok, up.err || up.out);
    }
    const hello = await fetch(`${web.base}/http/orders/hello`, { method: "POST", headers: { "content-type": "application/json", origin: web.base }, body: JSON.stringify({ from: "web" }) }).then(json);
    check("the main app's controller calls the service across the stacks", hello.service === "orders" && hello.calls === 1, hello);
    const action = await call(web.base, "orders:hello", { from: "an action" });
    check("and so does its action, through the same class", action.result?.calls === 2, action);
    const admin = (path: string) => fetch(`${web.base}/_admin/${path}`, { headers: { "x-admin-key": web.env("ADMIN_KEY")! } }).then(json);
    const listed = await admin("microservices");
    check("the main app's dashboard lists the service at its address on the network", JSON.stringify(listed.services) === JSON.stringify([{ name: "orders", url: "http://orders:3000" }]), listed);
    const server = await admin("server?target=orders");
    check("and reaches its admin API, where the service reports to the main app", server.dashboardUrl === "http://web:3000" && server.telemetry === false, server);
    const refused = sh(["docker", "exec", sh(["docker", "compose", "ps", "-q", "app"], web.dir).out, "wget", "-qO-", "--post-data", "{}", "http://orders:4001/orders.hello"], web.dir);
    check("the service refuses a call without the token", !refused.ok && /401/.test(refused.err), refused.err);
  } finally {
    for (const app of [web, orders]) app.cli("down", "--volumes");
    sh(["docker", "network", "rm", "e2e-shop-apps"], m.root);
  }
}

const which = process.argv[2];
try {
  if (!which || which === "plain") await plain();
  if (!which || which === "framework") await framework();
  if (!which || which === "backend") await backend();
  if (!which || which === "nest") await nest();
  if (!which || which === "monorepo") await monorepo();
  if (which === "caddy") await caddy();
  console.log(process.argv.includes("--no-docker") ? "\n✓ End-to-end passed without Docker" : "\n✓ Docker end-to-end passed");
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
}
