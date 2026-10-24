#!/usr/bin/env bun
// End to end for `archlast-forge dev`: a full-stack app on this machine (alone, then with services in Docker), and a backend
// whose engine runs in Docker. Checks live reload of pages and functions, and that stopping leaves nothing running.
//   bun scripts/pack.ts && bun scripts/e2e-dev.ts [framework|services|backend]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, check, createProject, json, sh, signUp, type Project } from "./lib/e2e";

/** `archlast-forge dev` running in a project, with its output collected. */
function startDev(p: Project, args: string[] = []) {
  const proc = Bun.spawn(["bunx", "archlast-forge", "dev", "--port", String(p.port), ...args], { cwd: p.dir, env: { ...process.env, FORCE_COLOR: "" }, stdout: "pipe", stderr: "pipe" });
  let output = "";
  for (const stream of [proc.stdout, proc.stderr]) void (async () => { for await (const chunk of stream) output += new TextDecoder().decode(chunk); })();
  return {
    output: () => output,
    async ready(ms = 120_000) {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500)) if (await fetch(`${p.base}/ready`).then((r) => r.ok, () => false)) return;
      throw new Error(`dev never became ready. Output:\n${output}`);
    },
    async stop() {
      proc.kill("SIGINT");
      await Promise.race([proc.exited, Bun.sleep(30_000)]);
      return proc.exitCode;
    },
  };
}
const until = async (what: string, test: () => Promise<boolean>, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(200)) if (await test().catch(() => false)) return;
  throw new Error(`timed out waiting for ${what}`);
};
const edit = (file: string, from: string, to: string) => {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`${file} has no "${from}"`);
  writeFileSync(file, text.replace(from, to));
};

async function framework() {
  console.log("\nFull-stack app: `archlast-forge dev`");
  const p = createProject("e2e-dev-fullstack", "framework", [], 3201, 9201);
  const dev = startDev(p);
  try {
    await dev.ready();
    check("the banner says where everything is", /full-stack app/.test(dev.output()) && dev.output().includes(`${p.base}/_dashboard`) && /Admin key/.test(dev.output()), dev.output());
    const home = await (await fetch(`${p.base}/`)).text();
    check("the home page is rendered, with the reload script", home.includes("Realtime. Full-stack. One deploy.") && home.includes("/_app/__dev.js"));

    edit(join(p.dir, "app/routes/index.tsx"), "Realtime. Full-stack. One deploy.", "Edited while running");
    await until("a changed page", async () => (await (await fetch(`${p.base}/`)).text()).includes("Edited while running"));
    check("editing a page rebuilds it", true);

    writeFileSync(join(p.dir, "forge/extra.ts"), `import { query } from "@archlast-forge/runtime";\nexport const answer = query({ handler: () => 42 });\n`);
    await until("a new function", async () => (await json(await fetch(`${p.base}/rpc/extra:answer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).result === 42);
    check("adding a backend function makes it callable", true);
    await until("regenerated types", async () => readFileSync(join(p.dir, "forge/_generated/api.ts"), "utf8").includes("extra"));
    check("and updates the typed api", true);

    const cookie = await signUp(p.base, "dev@example.com", "Dev");
    await call(p.base, "messages:send", { body: "typed in dev" }, cookie);
    check("sessions, SQLite and SSR work together", (await (await fetch(`${p.base}/chat`, { headers: { cookie } })).text()).includes("typed in dev"));
    check("Ctrl-C stops it cleanly", (await dev.stop()) === 0);
  } finally {
    await dev.stop();
  }
}

async function services() {
  console.log("\nFull-stack app: `archlast-forge dev` with PostgreSQL, Redis and S3 in Docker");
  const p = createProject("e2e-dev-services", "framework", ["postgres", "redis", "s3"], 3202, 9202);
  const dev = startDev(p);
  const names = () => sh(["docker", "ps", "--format", "{{.Names}}", "--filter", "name=e2e-dev-services"], p.dir).out.split("\n").filter(Boolean);
  try {
    await dev.ready();
    const out = dev.output();
    check("the banner lists each service and where it listens", /postgres on localhost:\d+/.test(out) && /redis on localhost:\d+/.test(out) && /s3 on localhost:\d+/.test(out), out);
    const running = names();
    check("three containers run", running.length === 3, running);
    const pg = running.find((n) => n.endsWith("-postgres"))!;

    const cookie = await signUp(p.base, "svc@example.com", "Svc");
    await call(p.base, "messages:send", { body: "in postgres" }, cookie);
    check("the app uses PostgreSQL", sh(["docker", "exec", pg, "psql", "-U", "forge", "-d", "forge", "-c", "\\dt"], p.dir).out.includes("messages"));
    const slot = await call(p.base, "files:generateUploadUrl", { contentType: "text/plain" }, cookie);
    const put = await fetch(slot.result.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "dev upload" });
    check("uploads go to the storage container on localhost", put.ok, `${put.status}`);
    check("Ctrl-C stops the app", (await dev.stop()) === 0);
    await until("services to stop", async () => names().length === 0, 30_000);
    check("and the services it started", true);

    const again = startDev(p);
    try {
      await again.ready();
      const cookie2 = await signUp(p.base, "svc2@example.com", "Svc2").catch(() => cookie);
      check("the data is still there next time", (await (await fetch(`${p.base}/chat`, { headers: { cookie: cookie2 } })).text()).includes("in postgres"));
    } finally {
      await again.stop();
    }
  } finally {
    await dev.stop();
    for (const n of names()) sh(["docker", "rm", "-f", n], p.dir);
    for (const v of ["postgres", "redis", "s3"]) sh(["docker", "volume", "rm", "-f", ...sh(["docker", "volume", "ls", "-q", "--filter", `name=e2e-dev-services.*-${v}`], p.dir).out.split("\n").filter(Boolean)], p.dir);
  }
}

async function backend() {
  console.log("\nBackend: `archlast-forge dev` with the engine in Docker");
  const p = createProject("e2e-dev-backend", "backend", ["postgres", "redis"], 3203, 9203);
  const dev = startDev(p);
  try {
    await dev.ready();
    check("the banner says it is a backend in Docker", /backend/.test(dev.output()) && /Container/.test(dev.output()), dev.output());
    check("its HTTP route answers", (await json(await fetch(`${p.base}/http/hello`))).message.startsWith("Hello from"));
    const cookie = await signUp(p.base, "b@example.com", "Bee");
    check("functions run against PostgreSQL", typeof (await call(p.base, "messages:send", { body: "from docker dev" }, cookie)).result === "string");

    edit(join(p.dir, "forge/http.ts"), "Hello from", "Edited hello from");
    await until("a reloaded route", async () => (await json(await fetch(`${p.base}/http/hello`))).message.startsWith("Edited hello from"));
    check("editing forge/ reloads it in the container", true);
    await dev.stop();
    await until("containers to stop", async () => sh(["docker", "ps", "-q", "--filter", "name=e2e-dev-backend"], p.dir).out === "", 40_000);
    check("Ctrl-C stops the engine and its services", true);
  } finally {
    await dev.stop();
    const left = sh(["docker", "ps", "-aq", "--filter", "name=e2e-dev-backend"], p.dir).out.split("\n").filter(Boolean);
    if (left.length) sh(["docker", "rm", "-f", ...left], p.dir);
  }
}

/** Each run is a new temporary project, so its containers and volumes have a name nobody will use again. */
function removeTestLeftovers() {
  const q = (kind: string[], filter: string) => sh(["docker", ...kind, "-q", "--filter", `name=${filter}`], ".").out.split("\n").filter(Boolean);
  const containers = q(["ps", "-a"], "archlast-forge-e2e-");
  if (containers.length) sh(["docker", "rm", "-f", ...containers], ".");
  const volumes = q(["volume", "ls"], "archlast-forge-e2e-");
  if (volumes.length) sh(["docker", "volume", "rm", "-f", ...volumes], ".");
  const networks = q(["network", "ls"], "archlast-forge-e2e-");
  if (networks.length) sh(["docker", "network", "rm", ...networks], ".");
}

const which = process.argv[2];
process.on("exit", removeTestLeftovers);
try {
  if (!which || which === "framework") await framework();
  if (!which || which === "services") await services();
  if (!which || which === "backend") await backend();
  console.log("\n✓ dev end-to-end passed");
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
}
