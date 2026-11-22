import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createConnection, isIP } from "node:net";
import { join } from "node:path";
import type { MobileProject } from "./config";
import {
  executable,
  freePort,
  hostEnvironment,
  requireCommand,
  run,
  waitFor,
  type Supervisor,
} from "./process";
import { expoGoApk, findAdb, sdkCommand, sdkFor } from "./toolchain";

type Device = { serial: string; state: string; detail: string };

export function parseDevices(output: string): Device[] {
  const devices: Device[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^(\S+)\s+(device|offline|unauthorized|no permissions|recovery|bootloader|sideload)(?:\s+(.*))?$/.exec(
        line,
      );
    if (match)
      devices.push({
        serial: match[1]!,
        state: match[2]!,
        detail: match[3] ?? "",
      });
  }
  return devices;
}

export function selectDevice(devices: Device[], serial?: string) {
  if (serial) {
    const device = devices.find((device) => device.serial === serial);
    if (device?.state !== "device")
      throw new Error(
        `ADB target ${serial} is ${device?.state ?? "absent"}. Unlock it, authorize USB debugging, and run mobile doctor.`,
      );
    return device;
  }
  const physical = devices.filter(
    (device) =>
      !device.serial.startsWith("emulator-") &&
      (/\busb:/.test(device.detail) || !/[:.]/.test(device.serial)) &&
      device.state === "device",
  );
  if (physical.length > 1)
    throw new Error(
      `Multiple Android devices are ready. Pass --device <serial>: ${physical.map((d) => d.serial).join(", ")}.`,
    );
  return physical[0];
}

/** ADB's host:version query is read-only and never starts a server. */
async function adbServerProtocol() {
  const socket = process.env.ADB_SERVER_SOCKET;
  const endpoint = socket ? /^tcp:(?:(.+):)?(\d+)$/.exec(socket) : undefined;
  if (socket && !endpoint)
    throw new Error(
      "Forge mobile supports a TCP ADB_SERVER_SOCKET. Use adb directly for other transports.",
    );
  const host = endpoint?.[1]?.replace(/^\[|\]$/g, "") ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error(
      "ADB reverse needs an ADB server on this computer. Unset the remote ADB_SERVER_SOCKET.",
    );
  const port = Number(
    endpoint?.[2] ?? process.env.ANDROID_ADB_SERVER_PORT ?? 5037,
  );
  return new Promise<number | undefined>((resolve) => {
    const connection = createConnection({ host, port });
    let response = "";
    function finish(version?: number) {
      connection.destroy();
      resolve(version);
    }
    connection.setTimeout(750);
    connection.once("connect", () => connection.write("000chost:version"));
    connection.once("error", () => finish());
    connection.once("timeout", () => finish());
    connection.once("end", () => finish());
    connection.on("data", (chunk) => {
      response += chunk.toString();
      if (response.startsWith("FAIL")) return finish();
      if (response.startsWith("OKAY") && response.length >= 12)
        finish(parseInt(response.slice(8, 12), 16));
    });
  });
}

export async function adbDevices(
  adb: string,
  readOnly = false,
  signal?: AbortSignal,
) {
  const server = await adbServerProtocol();
  if (server === undefined && readOnly) return undefined;
  const env = hostEnvironment();
  if (server !== undefined) {
    const local = await requireCommand(adb, ["version"], { env, signal });
    const version = Number(
      /Android Debug Bridge version \d+\.\d+\.(\d+)/.exec(local)?.[1],
    );
    if (version !== server)
      throw new Error(
        `The shared ADB server uses protocol ${server}; ${adb} uses ${version}. Use the matching adb on PATH.`,
      );
  }
  return parseDevices(
    await requireCommand(adb, ["devices", "-l"], { env, signal }),
  );
}

export function waydroidAddress(status: string) {
  const endpoint = /^ADB (?:address|endpoint):\s+(\S+)/im.exec(status)?.[1];
  const ip = /^IP (?:address|addr):\s+(\S+)/im.exec(status)?.[1];
  const address = endpoint ?? ip;
  if (!address) return;
  const withPort = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(address);
  const host = withPort ? (withPort[1] ?? withPort[2])! : address;
  const port = Number(
    withPort?.[3] ?? /^ADB port:\s*(\d+)\s*$/im.exec(status)?.[1] ?? 5555,
  );
  const family = isIP(host);
  if (!family || port < 1 || port > 65535) return;
  return family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export async function waydroidStatus(signal?: AbortSignal) {
  if (
    process.platform !== "linux" ||
    (!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== "wayland")
  )
    return { detail: "requires a Linux Wayland session" };
  const waydroid = executable("waydroid");
  if (!waydroid) return { detail: "Waydroid is not installed" };
  const status = await run(waydroid, ["status"], { signal, timeout: 3000 });
  if (status.code !== 0 || !/^Session:\s+RUNNING\s*$/im.test(status.out))
    return {
      detail: "Waydroid session is stopped. Start it from the desktop.",
    };
  const serial = waydroidAddress(status.out);
  if (!serial)
    return {
      detail:
        "Waydroid is running, but its status did not report an ADB address. Connect with ADB and pass --device",
    };
  return { detail: `session running at ${serial}`, serial };
}

export function accelerationHint() {
  if (process.platform === "win32")
    return "Enable CPU virtualization in firmware and Windows Hypervisor Platform (WHPX), then reboot.";
  if (process.platform === "darwin")
    return "Check Hypervisor.Framework support and use a system image that matches your Mac's CPU.";
  return "Enable CPU virtualization in firmware, load KVM, and make /dev/kvm readable and writable by your user.";
}

export async function emulatorAcceleration(
  project: MobileProject,
  signal?: AbortSignal,
) {
  const sdk = sdkFor(project, true);
  if (!existsSync(sdk.emulator)) {
    if (process.platform === "linux") {
      try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
      } catch {
        return { ready: false, detail: accelerationHint() };
      }
    }
    return {
      ready: false,
      detail:
        "Managed emulator missing. Run archlast-forge mobile setup --target emulator.",
    };
  }
  const acceleration = await run(sdk.emulator, ["-accel-check"], {
    env: sdk.env,
    timeout: 10_000,
    signal,
  });
  const status = /^accel:\s*(-?\d+)/im.exec(acceleration.out)?.[1];
  const ready =
    acceleration.code === 0 && (status === undefined || status === "0");
  return {
    ready,
    detail: ready
      ? acceleration.out
      : `${acceleration.out || acceleration.err} ${accelerationHint()}`,
  };
}

async function emulatorPort() {
  for (let port = 5554; port <= 5680; port += 2) {
    try {
      await freePort(port);
      await freePort(port + 1);
      return port;
    } catch {
      /* another emulator owns this pair */
    }
  }
  throw new Error(
    "No free Android emulator console/ADB port pair from 5554 to 5681.",
  );
}

async function startEmulator(
  project: MobileProject,
  supervisor: Supervisor,
  cleanups: (() => Promise<void> | void)[],
) {
  const sdk = sdkFor(project, true);
  const signal = supervisor.signal;
  const acceleration = await emulatorAcceleration(project, signal);
  if (!acceleration.ready) throw new Error(acceleration.detail);
  const hostAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  if (project.abi !== hostAbi)
    throw new Error(
      `An accelerated emulator on this host requires --android-abi ${hostAbi}.`,
    );
  const port = await emulatorPort();
  const serial = `emulator-${port}`;
  const sessions = join(project.home, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const avdHome = mkdtempSync(join(sessions, "avd-"));
  cleanups.push(() => rmSync(avdHome, { recursive: true, force: true }));
  const name = `forge_${process.pid}_${port}`;
  const env = { ...sdk.env, ANDROID_AVD_HOME: avdHome };
  await requireCommand(
    ...sdkCommand(sdk, "avdmanager", [
      "create",
      "avd",
      "--name",
      name,
      "--package",
      project.image,
      "--device",
      project.profile,
    ]),
    { env, input: "no\n", signal, timeout: 60_000 },
  );
  supervisor.start(
    "Android Emulator",
    sdk.emulator,
    [
      "-avd",
      name,
      "-port",
      String(port),
      "-no-window",
      "-no-audio",
      "-gpu",
      "swiftshader",
      "-no-boot-anim",
      "-no-snapshot",
      "-accel",
      "on",
    ],
    project.root,
    env,
  );
  return { serial, name };
}

export async function androidTarget(
  project: MobileProject,
  supervisor: Supervisor,
  cleanups: (() => Promise<void> | void)[],
) {
  const signal = supervisor.signal;
  if (project.target === "ios-simulator")
    throw new Error(
      "iOS Simulator orchestration is a follow-up. Start Expo and open it with Xcode Simulator separately.",
    );
  const adb = findAdb(project);
  if (!adb)
    throw new Error(
      "adb is missing. Run archlast-forge mobile setup --target device, or set up the requested emulator.",
    );
  const env = hostEnvironment();
  const devices = (await adbDevices(adb, false, signal)) ?? [];
  const attached =
    project.target === "device" || project.target === "auto"
      ? selectDevice(devices, project.device)
      : undefined;
  if (project.target === "device" && !attached)
    throw new Error(
      "No authorized USB Android device. Unlock it, enable USB debugging, accept the prompt, or use --device with a listed serial.",
    );

  let serial = attached?.serial;
  let avd: string | undefined;
  if (!serial && (project.target === "auto" || project.target === "waydroid")) {
    const waydroid = await waydroidStatus(signal).catch((error) => {
      if (signal.aborted || project.target === "waydroid") throw error;
      return { detail: (error as Error).message, serial: undefined };
    });
    if (waydroid.serial) {
      const opts = { env, signal, timeout: 5000 };
      try {
        const response = await run(adb, ["connect", waydroid.serial], opts);
        if (response.code === 0) {
          const state = await run(
            adb,
            ["-s", waydroid.serial, "get-state"],
            opts,
          );
          if (state.code === 0 && state.out === "device")
            serial = waydroid.serial;
        }
      } catch (error) {
        if (signal.aborted || project.target === "waydroid") throw error;
      }
    }
    if (!serial && project.target === "waydroid")
      throw new Error(
        `Waydroid: ${waydroid.detail}. Check adb permissions and run mobile doctor.`,
      );
  }
  if (!serial)
    ({ serial, name: avd } = await startEmulator(
      project,
      supervisor,
      cleanups,
    ));
  const target = serial;
  const inDevice = (args: string[], timeout?: number) =>
    requireCommand(adb, ["-s", target, ...args], { env, signal, timeout });
  await waitFor(
    `Android target ${target} to boot`,
    avd ? 180_000 : 20_000,
    signal,
    async () => {
      try {
        if (
          avd &&
          (await inDevice(["emu", "avd", "name"], 2000)).split(/\r?\n/)[0] !==
            avd
        )
          return false;
        return (
          (await inDevice(["shell", "getprop", "sys.boot_completed"], 2000)) ===
          "1"
        );
      } catch {
        return false;
      }
    },
  );
  console.log(`Android target: ${target}`);
  return { adb, env, serial: target, inDevice };
}

type Android = Awaited<ReturnType<typeof androidTarget>>;

export function reverseMappings(output: string) {
  return new Map(
    output.split(/\r?\n/).flatMap((line) => {
      const match = /(tcp:\d+)\s+(tcp:\d+)$/.exec(line.trim());
      return match ? [[match[1]!, match[2]!] as const] : [];
    }),
  );
}

export async function reversePort(android: Android, port: number) {
  const endpoint = `tcp:${port}`;
  if (
    reverseMappings(await android.inDevice(["reverse", "--list"])).has(endpoint)
  )
    throw new Error(
      `Android port ${port} already has an ADB reverse mapping on ${android.serial}. Choose a different port.`,
    );
  const prefix = ["-s", android.serial, "reverse"];
  const opts = { env: android.env, timeout: 3000 };
  // Let this short mutation finish even if the session is interrupted so its cleanup is registered.
  await requireCommand(
    android.adb,
    [...prefix, "--no-rebind", endpoint, endpoint],
    opts,
  );
  return async () => {
    const { out } = await run(android.adb, [...prefix, "--list"], opts);
    if (reverseMappings(out).get(endpoint) === endpoint)
      await run(android.adb, [...prefix, "--remove", endpoint], opts);
  };
}

export function appIdentity(project: MobileProject) {
  if (project.client === "go")
    return { id: "host.exp.exponent", scheme: "exp" };
  const id = project.app?.android?.package;
  const configuredScheme = project.app?.android?.scheme ?? project.app?.scheme;
  const scheme = Array.isArray(configuredScheme)
    ? configuredScheme[0]
    : configuredScheme;
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z]\w*(?:\.[a-zA-Z]\w*)+$/.test(id) ||
    typeof scheme !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)
  )
    throw new Error(
      "The development client needs a valid Android package and URI scheme in apps/mobile/app.json.",
    );
  return { id, scheme };
}

export async function installClient(
  project: MobileProject,
  android: Android,
  signal: AbortSignal,
) {
  const { id } = appIdentity(project);
  if (project.apk) {
    if (!existsSync(project.apk))
      throw new Error(`APK not found: ${project.apk}`);
    try {
      await android.inDevice(["install", "-r", project.apk], 180_000);
    } catch (e) {
      if ((e as Error).message.includes("INSTALL_FAILED_NO_MATCHING_ABIS")) {
        const abi = await android.inDevice([
          "shell",
          "getprop",
          "ro.product.cpu.abilist",
        ]);
        const bridge = await android.inDevice([
          "shell",
          "getprop",
          "ro.dalvik.vm.native.bridge",
        ]);
        throw new Error(
          `The APK does not support Android ABIs ${abi}. Native bridge: ${bridge || "none"}. Use a compatible APK or device.`,
        );
      }
      throw e;
    }
  }
  const present = Boolean(
    (await android.inDevice(["shell", "pm", "list", "packages", id]))
      .split(/\r?\n/)
      .includes(`package:${id}`),
  );
  if (!present && project.client === "go") {
    console.log(
      `Expo Go for SDK ${project.sdk} is missing. Installing the verified APK (about 225 MB).`,
    );
    const apk = await expoGoApk(project, signal);
    await android.inDevice(["install", "-r", apk], 180_000);
  } else if (!present) {
    throw new Error(
      `Development client ${id} is missing. Install its APK or pass --apk <path>.`,
    );
  } else if (project.client === "go" && project.sdk) {
    const info = await android.inDevice(["shell", "dumpsys", "package", id]);
    const version = /\bversionName=(\d+)/.exec(info)?.[1];
    if (version && Number(version) !== project.sdk)
      throw new Error(
        `Expo Go on this device supports SDK ${version}; the project uses SDK ${project.sdk}. Install the matching version from https://expo.dev/go.`,
      );
  }
}
