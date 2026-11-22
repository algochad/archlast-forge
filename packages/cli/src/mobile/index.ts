import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  adbDevices,
  androidTarget,
  appIdentity,
  emulatorAcceleration,
  installClient,
  reversePort,
  selectDevice,
  waydroidStatus,
} from "./android";
import { mobileProject, type MobileFlags, type MobileProject } from "./config";
import {
  executable,
  freePort,
  hostEnvironment,
  requireCommand,
  supervise,
  waitFor,
} from "./process";
import { findAdb, missingArchiveTool, prepareSdk, sdkFor } from "./toolchain";

function expoCommand(project: MobileProject) {
  const node = executable("node");
  if (!node)
    throw new Error(
      "Expo needs Node.js on PATH. Install Node.js 22.13 or later for SDK 58.",
    );
  try {
    const file = Bun.resolveSync("expo/package.json", project.mobile);
    const { bin } = JSON.parse(readFileSync(file, "utf8"));
    return { node, cli: join(dirname(file), bin.expo) };
  } catch {
    throw new Error(
      "Expo is not installed. Run bun install at the workspace root.",
    );
  }
}

export async function mobileSetup(dir: string, flags: MobileFlags) {
  const project = mobileProject(dir, flags);
  if (project.target === "ios-simulator")
    throw new Error(
      "iOS Simulator orchestration is a follow-up. Use Xcode Simulator with Expo directly.",
    );
  const session = supervise();
  try {
    const adb = findAdb(project);
    const devices =
      adb && project.target === "auto"
        ? await adbDevices(adb, false, session.signal)
        : undefined;
    const physical = devices && selectDevice(devices);
    const waydroid =
      project.target === "auto" && !physical
        ? await waydroidStatus(session.signal)
        : undefined;
    const emulator =
      project.target === "emulator" ||
      (project.target === "auto" && !physical && !waydroid?.serial);
    if (!emulator && adb) {
      await requireCommand(adb, ["version"], {
        env: hostEnvironment(),
        signal: session.signal,
      });
      console.log(`ADB ready at ${adb}. Run archlast-forge dev --mobile.`);
      return;
    }
    const sdk = await prepareSdk(project, emulator, flags, session.signal);
    if (sdk && emulator) {
      const acceleration = await emulatorAcceleration(project, session.signal);
      console.log(`Emulator acceleration: ${acceleration.detail}`);
    }
  } catch (error) {
    if (!session.interrupted()) throw error;
  } finally {
    await session.stop();
  }
}

export async function mobileDoctor(dir: string, flags: MobileFlags) {
  const project = mobileProject(dir, flags);
  console.log(`Mobile workspace: ${project.root}`);
  console.log(
    `Target: ${project.target}; Expo SDK ${project.sdk || "unknown"} (${project.client}); Android API ${project.api} ${project.abi}.`,
  );
  console.log(`Managed Android tools: ${project.home}`);
  const archive = missingArchiveTool();
  if (archive) console.log(`SDK setup: host ${archive} command is missing.`);
  try {
    const { node } = expoCommand(project);
    const version = await requireCommand(node, ["--version"]);
    console.log(`Expo toolchain: installed; Node.js ${version}.`);
  } catch (error) {
    console.log(`Expo toolchain: ${(error as Error).message}`);
  }
  const adb = findAdb(project);
  if (adb) {
    try {
      const devices = await adbDevices(adb, true);
      if (!devices)
        console.log(
          "ADB: installed, no running server. Connect a device and run dev --mobile to start it.",
        );
      else {
        for (const device of devices)
          console.log(
            `ADB ${device.serial}: ${device.state}${device.state === "unauthorized" ? " (unlock the device and accept USB debugging)" : device.state === "offline" ? " (reconnect the device)" : device.state === "no permissions" ? " (check USB permissions and udev rules)" : ""}.`,
          );
        if (!devices.length) console.log("ADB: no connected devices.");
        const { id } = appIdentity(project);
        for (const device of devices.filter(
          ({ state, serial }) =>
            state === "device" &&
            (!project.device || project.device === serial),
        )) {
          const args = ["-s", device.serial, "shell"];
          const env = hostEnvironment();
          const installed = await requireCommand(
            adb,
            [...args, "pm", "list", "packages", id],
            { env, timeout: 3000 },
          );
          console.log(
            `App on ${device.serial}: ${installed.split(/\r?\n/).includes(`package:${id}`) ? `${id} installed` : `${id} missing${project.client === "go" ? "; dev can install Expo Go" : "; pass a development APK"}`}.`,
          );
          if (device.serial.includes(":")) {
            const abi = await requireCommand(
              adb,
              [...args, "getprop", "ro.product.cpu.abilist"],
              { env, timeout: 3000 },
            );
            const bridge = await requireCommand(
              adb,
              [...args, "getprop", "ro.dalvik.vm.native.bridge"],
              { env, timeout: 3000 },
            );
            if (!abi.includes("arm") && (!bridge || bridge === "0"))
              console.log(
                `ABI on ${device.serial}: ${abi}; no ARM translation detected. ARM-only APKs need an ARM-compatible target.`,
              );
          }
        }
      }
    } catch (error) {
      console.log(`ADB: ${(error as Error).message}`);
    }
  } else
    console.log(
      "ADB: missing. Run archlast-forge mobile setup --target device.",
    );
  const waydroid = await waydroidStatus().catch((error) => ({
    detail: (error as Error).message,
  }));
  console.log(`Waydroid: ${waydroid.detail}.`);
  const sdk = sdkFor(project, true);
  const acceleration = await emulatorAcceleration(project).catch((error) => ({
    ready: false,
    detail: (error as Error).message,
  }));
  console.log(
    `Emulator: ${acceleration.detail || (acceleration.ready ? "acceleration available" : "acceleration unavailable")} (${sdk.sdk}).`,
  );
  if (project.apk)
    console.log(
      `Requested APK: ${existsSync(project.apk) ? project.apk : `missing at ${project.apk}`}.`,
    );
  for (const [name, port] of [
    ["Forge", project.backendPort],
    ["Metro", project.metroPort],
  ] as const) {
    if (port === undefined)
      console.log(
        `${name}: an available loopback port is selected when dev starts.`,
      );
    else
      await freePort(port).then(
        () => console.log(`${name}: port ${port} is free.`),
        (error) => console.log(`${name}: ${error.message}`),
      );
  }
}

export async function startMobile(dir: string, flags: MobileFlags) {
  const project = mobileProject(dir, flags);
  const expo = expoCommand(project);
  const session = supervise();
  const workspaceCleanup: (() => void | Promise<void>)[] = [];
  const routeCleanup: (() => Promise<void>)[] = [];
  const signal = session.signal;
  try {
    await freePort(project.backendPort);
    let metro = await freePort(project.metroPort);
    while (project.workspacePorts.has(metro)) metro = await freePort();
    const backendUrl = `http://127.0.0.1:${project.backendPort}`;
    const metroUrl = `http://127.0.0.1:${metro}`;
    const android = await androidTarget(project, session, workspaceCleanup);
    await installClient(project, android, signal);
    for (const port of [project.backendPort, metro]) {
      signal.throwIfAborted();
      routeCleanup.push(await reversePort(android, port));
    }
    const tools = hostEnvironment();
    session.start(
      "Forge workspace",
      process.execPath,
      [
        "--no-env-file",
        "run",
        "turbo",
        "run",
        "dev",
        "--ui=stream",
        "--env-mode=loose",
        ...project.filters,
      ],
      project.root,
      {
        ...tools,
        PORTLESS: "0",
        NODE_ENV: "development",
        DOCKER: process.env.DOCKER,
        ARCHLAST_ENGINE_IMAGE: process.env.ARCHLAST_ENGINE_IMAGE,
        ARCHLAST_NO_DOCKER: process.env.ARCHLAST_NO_DOCKER,
        FORGE_MOBILE_MAIN_PORT: String(project.backendPort),
      },
    );
    await waitFor("Forge /ready", 90_000, signal, async () => {
      const ready = await fetch(`${backendUrl}/ready`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(800)]),
      }).catch(() => null);
      return Boolean(
        ready?.ok && (await ready.json().catch(() => null))?.ready === true,
      );
    });

    session.start(
      "Expo Metro",
      expo.node,
      [
        expo.cli,
        "start",
        "--localhost",
        "--port",
        String(metro),
        project.client === "go" ? "--go" : "--dev-client",
      ],
      project.mobile,
      {
        ...tools,
        CI: "1",
        EXPO_PUBLIC_API_URL: backendUrl,
      },
    );
    await waitFor("Expo Metro", 90_000, signal, async () => {
      const ready = await fetch(`${metroUrl}/status`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(800)]),
      }).catch(() => null);
      return Boolean(
        ready?.ok && (await ready.text()).includes("packager-status:running"),
      );
    });

    const { id, scheme } = appIdentity(project);
    const uri =
      project.client === "go"
        ? `exp://127.0.0.1:${metro}`
        : `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;
    const launched = await android.inDevice([
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      uri,
      "-p",
      id,
    ]);
    if (/\berror\b/i.test(launched))
      throw new Error(`Android could not open ${id}. ${launched}`);
    console.log(
      `Mobile dev on ${android.serial}. Forge ${backendUrl}; Metro ${metroUrl}. Ctrl-C stops the session.`,
    );
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    signal.throwIfAborted();
  } catch (error) {
    if (!session.interrupted()) throw error;
  } finally {
    const cleanup = async (tasks: (() => void | Promise<void>)[]) => {
      for (const task of tasks.reverse()) {
        try {
          await task();
        } catch (error) {
          console.warn(`Mobile cleanup: ${(error as Error).message}`);
        }
      }
    };
    await cleanup(routeCleanup);
    await session.stop();
    await cleanup(workspaceCleanup);
  }
}
