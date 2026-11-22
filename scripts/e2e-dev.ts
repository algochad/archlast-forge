#!/usr/bin/env bun
// End to end for `archlast-forge dev`: a full-stack app on this machine (alone, then with services in Docker), and a backend
// whose engine runs in Docker. Checks live reload of pages and functions, and that stopping leaves nothing running.
//   bun scripts/pack.ts && bun scripts/e2e-dev.ts [framework|services|backend|monorepo|portless]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call, check, createMonorepo, createProject, json, must, sh, signUp, type Project } from "./lib/e2e";

/** `archlast-forge dev` running in a project, with its output collected. */
function startDev(p: Project, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bunx", "archlast-forge", "dev", "--port", String(p.port), ...args], { cwd: p.dir, env: { ...process.env, FORCE_COLOR: "", ...env }, stdout: "pipe", stderr: "pipe" });
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
  // Behind code-server's port forwarding the browser's origin is not localhost; signing in must still work.
  const dev = startDev(p, [], { VSCODE_PROXY_URI: "https://{{port}}.proxy.test/" });
  try {
    await dev.ready();
    const behindProxy = await fetch(`${p.base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: `https://${p.port}.proxy.test` }, body: JSON.stringify({ email: "proxy@example.com", password: "correct horse battery", name: "Proxy" }) });
    check("signing up works through a port-forwarding proxy's origin", behindProxy.ok, `${behindProxy.status} ${await behindProxy.text()}`);
    check("the banner says where everything is", /full-stack app/.test(dev.output()) && dev.output().includes(`${p.base}/_dashboard`) && /Admin key/.test(dev.output()), dev.output());
    const home = await (await fetch(`${p.base}/`)).text();
    check("the home page is rendered, with the reload script", home.includes("Realtime. Full-stack. One deploy.") && home.includes("/_app/__dev.js"));

    edit(join(p.dir, "app/routes/index.tsx"), "Realtime. Full-stack. One deploy.", "Edited while running");
    await until("a changed page", async () => (await (await fetch(`${p.base}/`)).text()).includes("Edited while running"));
    check("editing a page rebuilds it", true);

    const reloads = await fetch(`${p.base}/_app/__events`, { signal: AbortSignal.timeout(10_000) });
    const reader = reloads.body!.pipeThrough(new TextDecoderStream()).getReader();
    try {
      writeFileSync(join(p.dir, "forge/extra.ts"), `import { query } from "@archlast/forge-runtime";\nawait Bun.sleep(750);\nexport const answer = query({ handler: () => 42 });\n`);
      let events = "";
      while (!events.includes('"type":"reload"')) {
        const { value, done } = await reader.read();
        if (done) throw new Error("live reload stream closed before the backend edit reached the browser");
        events += value;
      }
      check("the browser refreshes after the replacement runtime is ready", (await fetch(`${p.base}/ready`)).ok);
    } finally {
      await reader.cancel();
    }
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

async function monorepo() {
  console.log("\nForge RPC monorepo: root Turbo dev, contracts and upgrade");
  const sockets = Array.from({ length: 5 }, () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
  );
  const [webPort, ordersPort, billingPort, ordersRpc, billingRpc] = sockets.map(
    (socket) => socket.port!,
  );
  await Promise.all(sockets.map((socket) => socket.stop(true)));
  const { root, apps } = createMonorepo(
    "e2e-workspace",
    "framework",
    [],
    ["orders", "billing"],
    { web: webPort!, orders: ordersPort!, billing: billingPort! },
  );
  const { web, orders, billing } = apps as Record<
    "web" | "orders" | "billing",
    (typeof apps)[string]
  >;
  const workspaceFile = join(root, "archlast-forge.workspace.json");
  const workspace = await Bun.file(workspaceFile).json();
  workspace.portless = false; // Exercise the configured direct ports in this scenario.
  workspace.mainPort = webPort;
  workspace.apps.orders = {
    kind: "service",
    port: ordersPort,
    rpcPort: ordersRpc,
  };
  workspace.apps.billing = {
    kind: "service",
    port: billingPort,
    rpcPort: billingRpc,
  };
  workspace.dependsOn = { web: ["orders"], orders: ["billing"] };
  writeFileSync(workspaceFile, JSON.stringify(workspace));
  const appPackage = join(orders.dir, "package.json");
  const ordersPackage = await Bun.file(appPackage).json();
  ordersPackage.devDependencies["@e2e-workspace/contracts"] = "workspace:*";
  writeFileSync(appPackage, JSON.stringify(ordersPackage));
  const router = join(orders.dir, "forge/orders.router.ts");
  edit(
    router,
    "import { internal }",
    'import type { BillingRpc } from "@e2e-workspace/contracts";\nimport { createForgeRpcClient } from "@archlast/forge-runtime/nest/rpc";\nimport { internal }',
  );
  edit(
    router,
    'return { service: "orders", greeting:',
    'const billing = createForgeRpcClient<BillingRpc>({ url: process.env.BILLING_RPC_URL!, token: process.env.BILLING_RPC_TOKEN });\n        await billing.billing.hello.mutate({ from });\n        return { service: "orders", greeting:',
  );
  const webPackage = join(web.dir, "package.json");
  const webManifest = await Bun.file(webPackage).json();
  webManifest.scripts["forge:seed"] = "bun seed.ts";
  writeFileSync(webPackage, JSON.stringify(webManifest));
  writeFileSync(
    join(web.dir, "seed.ts"),
    'const res = await fetch(process.env.FORGE_DEV_URL + "/ready"); if (!res.ok) throw new Error("seed started too soon"); await Bun.write(".forge-seeded", "ready");',
  );
  must(["bun", "run", "workspace", "sync"], root);
  must(["bun", "run", "typecheck"], root);
  check(
    "root typecheck generates contracts on a clean checkout",
    existsSync(join(billing.dir, "forge/_generated/rpc.ts")),
  );
  const cli = join(root, "node_modules", ".bin", "archlast-forge");
  check("root has a project-local Forge CLI", existsSync(cli));
  must(["bun", "run", "upgrade", "0.21.0"], root);
  check(
    "root upgrade updates both service images and keeps generated contracts",
    [orders, billing].every(
      (app) =>
        readFileSync(join(app.dir, "Dockerfile"), "utf8").includes(
          "archlast-forge-engine:0.21.0",
        ) && existsSync(join(app.dir, "forge/_generated/rpc.ts")),
    ),
  );
  writeFileSync(
    join(web.dir, ".env"),
    "DATABASE_URL=production-profile-must-not-load\n",
    { flag: "a" },
  );

  function start(filtered = false) {
    let output = "";
    const decoder = new TextDecoder();
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "dev",
        "--ui=stream",
        ...(filtered ? ["--filter=@e2e-workspace/web"] : []),
      ],
      {
        cwd: root,
        env: { ...process.env, FORCE_COLOR: "" },
        terminal: {
          data: (_terminal, data) => {
            output += decoder.decode(data, { stream: true });
          },
        },
      },
    );
    return { proc, output: () => output };
  }
  async function stop(proc: ReturnType<typeof start>["proc"]) {
    if (proc.exitCode === null) proc.terminal!.write("\x03");
    const code = await Promise.race([
      proc.exited,
      Bun.sleep(15_000).then(() => null),
    ]);
    if (code === null) proc.kill("SIGKILL");
    proc.terminal!.close();
    await until("workspace ports to be released", async () => {
      const ports = [webPort, ordersPort, billingPort, ordersRpc, billingRpc];
      const busy = await Promise.all(
        ports.map((port) =>
          fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(200),
          }).then(
            () => true,
            () => false,
          ),
        ),
      );
      return busy.every((state) => !state);
    });
  }

  const ready = () => fetch(`${web.base}/ready`).then((r) => r.ok);
  const runHello = () => call(web.base, "orders:hello", { from: "workspace" });
  let cookie: string;
  const local = start();
  try {
    await until(
      "the workspace and its seed",
      async () => (await ready()) && existsSync(join(web.dir, ".forge-seeded")),
      60_000,
    );
    check(
      "root Turbo dev runs a typed main → service → service call",
      (await runHello()).result?.calls === 1,
    );
    cookie = await signUp(web.base, "workspace@example.com", "Workspace");
    await call(
      web.base,
      "messages:send",
      { body: "persisted in workspace dev" },
      cookie,
    );
    const status = must(["bun", "run", "workspace", "status"], root);
    check(
      "workspace status shows three ready SQLite apps",
      status.split("\n").filter((line) => line.includes(" ready  SQLite"))
        .length === 3,
    );
    const { ADMIN_KEY } = await Bun.file(
      join(web.dir, "forge/data/.dev-secrets.json"),
    ).json();
    check(
      "workspace logs keep the development admin key private",
      !local.output().includes(ADMIN_KEY),
    );
    writeFileSync(
      join(web.dir, "forge/workspaceProbe.ts"),
      'import { query } from "@archlast/forge-runtime"; export const value = query({ handler: () => "reloaded" });',
    );
    await until(
      "the added live function",
      async () =>
        (await call(web.base, "workspaceProbe:value", {})).result ===
        "reloaded",
    );
    check(
      "native dev regenerates the main app API",
      readFileSync(join(web.dir, "forge/_generated/api.ts"), "utf8").includes(
        "workspaceProbe",
      ),
    );
    edit(
      router,
      "calls: z.number()",
      "calls: z.number(), updated: z.boolean()",
    );
    edit(
      router,
      "greeting: `Hello, ${from}`, calls",
      "greeting: `Hello, ${from}`, calls, updated: true",
    );
    await until(
      "the updated router contract",
      async () => (await runHello()).result?.updated === true,
    );
    check(
      "native dev refreshes the service contract",
      readFileSync(
        join(orders.dir, "forge/_generated/rpc.ts"),
        "utf8",
      ).includes("updated: boolean"),
    );
    edit(
      join(web.dir, "app/routes/index.tsx"),
      "Realtime. Full-stack. One deploy.",
      "Workspace page reloaded",
    );
    await until("the edited workspace page", async () =>
      (await (await fetch(web.base)).text()).includes(
        "Workspace page reloaded",
      ),
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${local.output()}`);
  } finally {
    await stop(local.proc);
  }

  const filtered = start(true);
  try {
    await until("the filtered workspace", ready, 60_000);
    check(
      "a Turbo filter starts the declared chain and services retain their data",
      (await runHello()).result?.calls > 1,
    );
    check(
      "restart preserves sessions and the app database",
      (
        await (
          await fetch(`${web.base}/chat`, { headers: { cookie: cookie! } })
        ).text()
      ).includes("persisted in workspace dev"),
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${filtered.output()}`);
  } finally {
    await stop(filtered.proc);
  }

  const heldPort = Bun.serve({
    hostname: "127.0.0.1",
    port: billingRpc,
    fetch: () => new Response(),
  });
  const blocked = start(true);
  try {
    await until("the occupied-port diagnostic", async () =>
      blocked.output().includes(`Development port ${billingRpc} is occupied`),
    );
  } finally {
    await heldPort.stop(true);
    await stop(blocked.proc);
  }

  if (!process.argv[2] || process.argv.includes("--with-infra")) {
    writeFileSync(
      join(web.dir, ".env.development.local"),
      "FORGE_DEV_SERVICES=postgres\n",
      { mode: 0o600 },
    );
    const postgres = start(true);
    const volume = `archlast-forge-web-${Bun.hash(web.dir).toString(16).slice(0, 6)}-dev-postgres`;
    try {
      await until("workspace dev with Postgres", ready, 60_000);
      const pg = await signUp(web.base, "postgres@example.com", "Postgres");
      await call(
        web.base,
        "messages:send",
        { body: "written to dev Postgres" },
        pg,
      );
      const tables = must(
        [
          "docker",
          "exec",
          volume,
          "psql",
          "-U",
          "forge",
          "-d",
          "forge",
          "-Atc",
          "select to_regclass('public.messages')",
        ],
        root,
      );
      check(
        "only the selected app uses managed development Postgres",
        tables === "messages" &&
          must(["bun", "run", "workspace", "status"], root).includes(
            " ready  Postgres",
          ),
      );
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${postgres.output()}`);
    } finally {
      await stop(postgres.proc);
    }
    const running = sh(
      [
        "docker",
        "container",
        "inspect",
        "--format",
        "{{.State.Running}}",
        volume,
      ],
      root,
    );
    check(
      "the development container stops and its volume survives",
      running.out !== "true" &&
        sh(["docker", "volume", "inspect", volume], root).ok,
    );
    if (running.ok) must(["docker", "container", "rm", volume], root);
    must(["docker", "volume", "rm", volume], root);
  }
}

async function portless() {
  console.log("\nPortless: named HTTPS for two projects and a filtered Forge RPC workspace");
  const stateDir = mkdtempSync(join(tmpdir(), "forge-portless-"));
  const reserve = () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const proxyPort = reserve();
  const orderRpc = reserve();
  const env = {
    PORTLESS: "1",
    PORTLESS_HTTPS: "1",
    PORTLESS_PORT: String(proxyPort.port),
    PORTLESS_STATE_DIR: stateDir,
    PORTLESS_TLD: "localhost",
  };
  const backend = createProject("e2e-named", "backend", ["s3"], 3000, 9000);
  const framework = createProject("e2e-named", "framework", [], 3000, 0);
  const { root } = createMonorepo("e2e-named-workspace", "framework", [], ["orders"], { web: 3000, orders: 3001 });
  const manifest = join(root, "archlast-forge.workspace.json");
  const workspace = await Bun.file(manifest).json();
  workspace.apps.orders.rpcPort = orderRpc.port;
  writeFileSync(manifest, JSON.stringify(workspace));
  await orderRpc.stop(true);

  const command = ["node", join(dirname(Bun.resolveSync("portless", join(import.meta.dir, "../packages/cli"))), "cli.js")];
  const runs: { stop: () => Promise<void>; output: () => string }[] = [];
  function dev(dir: string, ...args: string[]) {
    let output = "";
    const decoder = new TextDecoder();
    const proc = Bun.spawn(["bun", "run", "dev", ...args], {
      cwd: dir, env: { ...process.env, ...env, FORCE_COLOR: "" },
      terminal: { data: (_, data) => { output += decoder.decode(data, { stream: true }); } },
    });
    const run = {
      output: () => output,
      async stop() {
        if (proc.exitCode === null) {
          proc.terminal!.write("\x03");
          if (await Promise.race([proc.exited, Bun.sleep(12_000).then(() => null)]) === null) {
            proc.kill("SIGKILL");
            await proc.exited;
            throw new Error(`Portless dev did not stop in ${dir}:\n${output}`);
          }
        }
        proc.terminal!.close();
      },
    };
    runs.push(run);
    return run;
  }
  const routes = (): { url: string; port: number }[] =>
    JSON.parse(must([...command, "list", "--json"], root, env)).routes;
  const caFile = join(stateDir, "ca.pem");
  const request = (url: string, init?: RequestInit) =>
    fetch(url, { signal: AbortSignal.timeout(3000), ...init, tls: { ca: readFileSync(caFile, "utf8") } });
  async function ready() {
    const active = routes();
    return (await Promise.all(active.map(async ({ url, port }) => {
      const upstream = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) });
      return upstream.ok && (await request(`${url}/ready`)).ok;
    }))).every(Boolean);
  }

  await proxyPort.stop(true);
  const proxy = Bun.spawn([...command, "proxy", "start", "--foreground", "--unprivileged", "--https", "--skip-trust"], {
    env: { ...process.env, ...env }, stdout: "ignore", stderr: "inherit",
  });
  try {
    await until("Portless's proxy", async () => existsSync(join(stateDir, "proxy.port")));
    const api = dev(backend.dir);
    const web = dev(framework.dir, "--no-docker");
    await until("both named projects", async () => routes().length === 2 && await ready(), 90_000)
      .catch((error) => { throw new Error(`${error.message}\n${api.output()}\n${web.output()}`); });
    const active = routes();
    const origin = active.find(({ url }) => web.output().includes(`${url}/_dashboard`))!.url;
    check("same-name projects use distinct URLs and dynamically assigned HTTP ports",
      new Set(active.map(({ url }) => url)).size === 2 &&
      new Set(active.map(({ port }) => port)).size === 2 && active.every(({ port }) => port !== 3000));
    const signUp = await request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "portless@example.com", password: "correct horse battery", name: "Portless" }),
    });
    check("Better Auth accepts the named origin and issues a secure cookie",
      signUp.ok && signUp.headers.getSetCookie().some((line) => line.includes("; Secure")), await signUp.text());
    const apiOrigin = active.find(({ url }) => url !== origin)!.url;
    check("the Docker backend runs behind its named URL", api.output().includes("engine in Docker") && api.output().includes(apiOrigin));
    const apiSignUp = await request(`${apiOrigin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: apiOrigin },
      body: JSON.stringify({ email: "upload@example.com", password: "correct horse battery", name: "Upload" }),
    });
    check("Docker backend auth uses the named origin", apiSignUp.ok);
    const upload = await json(await request(`${apiOrigin}/rpc/files:generateUploadUrl`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: apiSignUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") },
      body: JSON.stringify({ contentType: "text/plain" }),
    }));
    const uploadUrl = new URL(upload.result.uploadUrl);
    check("Docker dev storage uses a free port separate from the named proxy", uploadUrl.hostname === "localhost" && uploadUrl.port !== "9000", uploadUrl.origin);
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "portless upload" });
    check("the managed storage accepts a signed upload", put.ok, put.status);
    check("dashboard lookup finds the named URL", must(["bun", "run", "archlast-forge", "dashboard"], framework.dir, env) === `${origin}/_dashboard`);
    const openapi = await json(await request(`${origin}/_api/openapi.json`));
    check("the OpenAPI server is the public URL", openapi.servers[0]?.url === origin, openapi.servers);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace(/^https:/, "wss:")}/rpc`, {
        headers: { origin }, tls: { ca: readFileSync(caFile, "utf8") },
      });
      const timeout = setTimeout(() => { socket.close(); reject(new Error("Portless WebSocket timed out")); }, 5000);
      socket.addEventListener("open", () => { clearTimeout(timeout); socket.close(); resolve(); });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Portless WebSocket failed")); });
    });
    await api.stop();
    await web.stop();
    await until("standalone routes to be removed", async () => routes().length === 0);

    const filtered = dev(root, "--ui=stream", "--filter=@e2e-named-workspace/web");
    await until("the filtered named workspace", async () => routes().length === 2 && await ready(), 65_000)
      .catch((error) => { throw new Error(`${error.message}\n${filtered.output()}`); });
    const workspaceWeb = routes().find(({ url }) => new URL(url).hostname.startsWith("e2e-named-workspace-web-"))!.url;
    const echo = await json(await request(`${workspaceWeb}/rpc/orders:hello`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "Portless" }),
    }));
    check("a filtered Turbo run starts the named service and keeps typed Forge RPC working", echo.result?.service === "orders", echo);
    const status = must(["bun", "run", "workspace", "status"], root, env);
    check("workspace status shows both public URLs and readiness", routes().every(({ url }) => status.includes(url)) && status.match(/\bready\b/g)?.length === 2, status);
    await filtered.stop();
    await until("workspace routes to be removed", async () => routes().length === 0);

    const restarted = dev(framework.dir, "--no-docker");
    await until("the original named URL after restart", async () => routes().some(({ url }) => url === origin) && await ready(), 45_000)
      .catch((error) => { throw new Error(`${error.message}\n${restarted.output()}`); });
    check("the public URL survives a restart", true);
  } finally {
    try {
      await Promise.allSettled(runs.map((run) => run.stop()));
    } finally {
      proxy.kill();
      await proxy.exited;
      rmSync(stateDir, { recursive: true, force: true });
      const { containerName } = await import("../packages/cli/src/docker");
      removeTestLeftovers(containerName(backend.dir, true));
    }
  }
}

/** Each run is a new temporary project, so its containers and volumes have a name nobody will use again. */
function removeTestLeftovers(prefix = "archlast-forge-e2e-") {
  const q = (kind: string[], filter: string) => sh(["docker", ...kind, "-q", "--filter", `name=${filter}`], ".").out.split("\n").filter(Boolean);
  const containers = q(["ps", "-a"], prefix);
  if (containers.length) sh(["docker", "rm", "-f", ...containers], ".");
  const volumes = q(["volume", "ls"], prefix);
  if (volumes.length) sh(["docker", "volume", "rm", "-f", ...volumes], ".");
  const networks = q(["network", "ls"], prefix);
  if (networks.length) sh(["docker", "network", "rm", ...networks], ".");
}

const which = process.argv[2];
if (!which || ["services", "backend"].includes(which)) process.on("exit", () => removeTestLeftovers());
try {
  if (!which || which === "framework") await framework();
  if (!which || which === "services") await services();
  if (!which || which === "backend") await backend();
  if (!which || which === "monorepo") await monorepo();
  if (!which || which === "portless") await portless();
  console.log("\n✓ dev end-to-end passed");
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
}
