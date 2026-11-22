#!/usr/bin/env bun
// Run with bun scripts/pack.ts followed by bun scripts/e2e-mobile.ts.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { freePort, waitFor } from "../packages/cli/src/mobile/process";
import { check, createMonorepo, must, sh } from "./lib/e2e";

for (const entry of ["init", "add"] as const) {
  const { root, apps } = createMonorepo(
    `e2e-mobile-${entry}`,
    "backend",
    [],
    [],
    { api: 3000 },
    entry === "init" ? ["--mobile"] : [],
  );
  if (entry === "add")
    must(["bun", "run", "archlast-forge", "add", "mobile", "--yes"], root);
  const app = join(root, "apps", "mobile");
  must(["bun", "run", "codegen"], apps.api!.dir);
  console.log(`Checking the Expo scaffold from ${entry}`);
  const typecheck = sh(["bun", "run", "typecheck"], app);
  check("mobile typecheck", typecheck.ok, typecheck.out + "\n" + typecheck.err);
  const config = await Bun.file(join(app, "components.json")).json();
  const screen = await Bun.file(join(app, "App.tsx")).text();
  check(
    "the starter uses the React Native Reusables components and PortalHost",
    config.aliases.ui === "@/components/ui" &&
      ["button", "card", "input", "text"].every(
        (component) =>
          existsSync(join(app, "components", "ui", `${component}.tsx`)) &&
          screen.includes(`@/components/ui/${component}`),
      ) &&
      screen.includes("<PortalHost"),
  );
  if (entry === "init") {
    if (process.platform !== "win32") await supervisedSession(root);
    const doctor = sh(["bun", "run", "doctor"], app);
    check(
      "Expo project diagnostics",
      doctor.ok,
      doctor.out + "\n" + doctor.err,
    );
    const exported = sh(
      [
        "bun",
        "run",
        "export:android",
        "--output-dir",
        ".expo/forge-android-export",
      ],
      app,
    );
    check(
      "Metro bundles the Android starter",
      exported.ok,
      exported.out + "\n" + exported.err,
    );
    check(
      "Expo emitted Android bundle metadata",
      existsSync(join(app, ".expo", "forge-android-export", "metadata.json")),
    );
  }
}

/** Run real Forge, Turbo and Metro against a fixture ADB client/socket. No host device or SDK is touched. */
async function supervisedSession(root: string) {
  const fake = join(root, ".forge", "mobile-test");
  mkdirSync(fake, { recursive: true });
  const adb = join(fake, "adb");
  const state = join(fake, "routes.json");
  writeFileSync(state, JSON.stringify({ "tcp:9999": "tcp:8888" }));
  writeFileSync(
    adb,
    `#!/usr/bin/env bun
import { join } from "node:path";
const args = Bun.argv.slice(2);
const file = join(import.meta.dir, "routes.json");
const routes = await Bun.file(file).json();
if (args[0] === "version") console.log("Android Debug Bridge version 1.0.41");
else if (args[0] === "devices") {
  console.log("List of devices attached");
  console.log("fixture device usb:1-2");
}
else {
  if (args[0] !== "-s" || args[1] !== "fixture") throw Error("ADB call was not device-scoped: " + args);
  const command = args.slice(2).join(" ");
  if (command === "shell getprop sys.boot_completed") console.log("1");
  else if (command === "shell pm list packages host.exp.exponent") console.log("package:host.exp.exponent");
  else if (command === "shell dumpsys package host.exp.exponent") console.log("versionName=58.0.5");
  else if (command === "reverse --list") for (const [from, to] of Object.entries(routes)) console.log("fixture", from, to);
  else if (command.startsWith("reverse --no-rebind ")) {
    if (args[4] in routes) process.exit(1);
    routes[args[4]] = args[5];
    await Bun.write(file, JSON.stringify(routes));
  } else if (command.startsWith("reverse --remove ")) {
    delete routes[args[4]];
    await Bun.write(file, JSON.stringify(routes));
  } else if (!command.startsWith("shell am start ")) throw Error("Unexpected ADB call: " + command);
}
`,
  );
  chmodSync(adb, 0o700);

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        if (data.toString() === "000chost:version") socket.end("OKAY00040029");
        else socket.end("FAIL0000");
      },
    },
  });
  const backend = await freePort();
  let metro = await freePort();
  while (metro === backend) metro = await freePort();
  const processEnv = {
    ...process.env,
    PATH: `${fake}${delimiter}${process.env.PATH}`,
    ANDROID_ADB_SERVER_PORT: String(server.port),
    ADB_SERVER_SOCKET: "",
    FORGE_HOME: join(fake, "home"),
  };
  const cli = join(root, "node_modules", ".bin", "archlast-forge");
  async function mobileCommand(...args: string[]) {
    const child = Bun.spawn([cli, "mobile", ...args], {
      cwd: root,
      env: processEnv,
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(30_000),
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output: out + err, code };
  }
  const doctor = await mobileCommand("doctor", "--device", "fixture");
  check(
    "mobile doctor inspects an existing ADB server without writing routes",
    doctor.code === 0 &&
      doctor.output.includes("ADB fixture: device") &&
      JSON.stringify(await Bun.file(state).json()) ===
        '{"tcp:9999":"tcp:8888"}',
    doctor.output,
  );
  const setup = await mobileCommand("setup", "--target", "emulator", "--yes");
  check(
    "noninteractive SDK setup requires explicit license acceptance",
    setup.code !== 0 &&
      setup.output.includes("--accept-licenses") &&
      !existsSync(processEnv.FORGE_HOME),
    setup.output,
  );
  const proc = Bun.spawn(
    [
      cli,
      "dev",
      "--mobile",
      "--backend-port",
      String(backend),
      "--metro-port",
      String(metro),
    ],
    {
      cwd: root,
      env: processEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let output = "";
  for (const stream of [proc.stdout, proc.stderr])
    void (async () => {
      for await (const bytes of stream)
        output += new TextDecoder().decode(bytes);
    })();
  const timeout = AbortSignal.timeout(120_000);
  try {
    await waitFor(
      "the workspace and Android launch",
      100_000,
      timeout,
      async () => {
        if (proc.exitCode !== null)
          throw new Error(`Mobile dev stopped early.\n${output}`);
        return output.includes("Mobile dev on fixture");
      },
    );
    const routes = await Bun.file(state).json();
    check(
      "mobile dev reserves Metro and the configured Forge endpoint on the selected device",
      routes[`tcp:${backend}`] === `tcp:${backend}` &&
        routes[`tcp:${metro}`] === `tcp:${metro}`,
    );
    const ready = await fetch(`http://127.0.0.1:${backend}/ready`);
    check(
      "Forge's advertised Android endpoint answers",
      ready.ok && (await ready.json()).ready === true,
    );
    const status = await fetch(`http://127.0.0.1:${metro}/status`);
    check(
      "Metro serves the selected loopback port",
      (await status.text()).includes("packager-status:running"),
    );
    const origin = `http://127.0.0.1:${backend}`;
    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "expo-origin": `exp://127.0.0.1:${metro}/--/`,
      },
      body: JSON.stringify({
        email: "mobile@example.com",
        name: "Mobile",
        password: "correct horse battery",
      }),
    });
    check(
      "Better Auth accepts Expo Go's forwarded origin",
      signup.ok,
      await signup.text(),
    );
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const socket = new WebSocket(`ws://127.0.0.1:${backend}/rpc`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Forge WebSocket did not open")),
        5000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Forge WebSocket failed"));
        },
        { once: true },
      );
    }).finally(() => socket.close());
    check("the mobile API port also serves live WebSockets", true);
    const metroUrl = `http://127.0.0.1:${metro}`;
    const manifestResponse = await fetch(metroUrl, {
      headers: {
        accept: "application/expo+json",
        "expo-platform": "android",
        "expo-protocol-version": "0",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const manifestBody = await manifestResponse.text();
    check(
      "Expo provides an Android launch manifest",
      manifestResponse.ok,
      manifestBody.slice(0, 1000),
    );
    const launchAsset = new URL(JSON.parse(manifestBody).launchAsset.url);
    const bundle = await fetch(
      new URL(launchAsset.pathname + launchAsset.search, metroUrl),
      {
        signal: AbortSignal.timeout(90_000),
      },
    );
    const bundleBody = await bundle.text();
    check(
      "Metro embeds the session-specific backend URL",
      bundle.ok && bundleBody.includes(origin),
      bundle.ok
        ? "The Android bundle did not contain the forwarded Forge URL."
        : bundleBody.slice(0, 1000),
    );
  } finally {
    proc.kill("SIGINT");
    const code = await Promise.race([
      proc.exited,
      Bun.sleep(20_000).then(() => null),
    ]);
    if (code === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    server.stop(true);
    if (code !== 0) console.log(output);
  }
  const routes = await Bun.file(state).json();
  check(
    "Ctrl-C removes only this session's ADB routes",
    JSON.stringify(routes) === '{"tcp:9999":"tcp:8888"}',
    routes,
  );
  await freePort(backend);
  await freePort(metro);
  check("Ctrl-C releases both server ports", true);
}
