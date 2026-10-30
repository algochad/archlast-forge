#!/usr/bin/env bun
// End to end in Docker: scaffolds both kinds of project from the packed tarballs, brings each stack up with `archlast-forge up`,
// and checks what a user would: pages, the API, the database, Redis, uploads, a restart, and `down`.
//   bun scripts/pack.ts && bun scripts/e2e-docker.ts [framework|backend]
// Needs Docker and the engine image (`bun packages/cli/src/index.ts engine build`).
import { call, check, createProject, json, sh, signUp } from "./lib/e2e";

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

const which = process.argv[2];
try {
  if (!which || which === "plain") await plain();
  if (!which || which === "framework") await framework();
  if (!which || which === "backend") await backend();
  if (which === "caddy") await caddy();
  console.log("\n✓ Docker end-to-end passed");
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
}
