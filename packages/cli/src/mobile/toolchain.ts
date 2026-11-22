import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MobileFlags, MobileProject } from "./config";
import { expoGo, toolchains, toolchainVersion } from "./manifest";
import {
  executable,
  hostEnvironment,
  requireCommand,
  withPath,
} from "./process";

const windows = process.platform === "win32";
const host = `${process.platform}-${process.arch}`;
const binary = (name: string) => (windows ? `${name}.exe` : name);

function sdkPaths(sdk: string, user: string) {
  const tools = join(sdk, "cmdline-tools", "latest");
  const jdk = join(sdk, "jdk");
  const java =
    process.platform === "darwin" ? join(jdk, "Contents", "Home") : jdk;
  const platform = join(sdk, "platform-tools");
  return {
    sdk,
    user,
    adb: join(platform, binary("adb")),
    emulator: join(sdk, "emulator", binary("emulator")),
    tools,
    java: join(java, "bin", binary("java")),
    env: withPath(
      {
        ...hostEnvironment(),
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: sdk,
        ANDROID_USER_HOME: user,
        JAVA_HOME: java,
      },
      platform,
      join(java, "bin"),
    ),
  };
}

/** Match the entry points in Google's launch scripts without cmd.exe or shell quoting. */
export function sdkCommand(
  sdk: ReturnType<typeof sdkPaths>,
  tool: "sdkmanager" | "avdmanager",
  args: string[],
): [string, string[]] {
  const manager = tool === "sdkmanager";
  return [
    sdk.java,
    [
      `-Dcom.android.${manager ? "sdklib" : "sdkmanager"}.toolsdir=${sdk.tools}`,
      "-classpath",
      join(sdk.tools, "lib", `${tool}-classpath.jar`),
      manager
        ? "com.android.sdklib.tool.sdkmanager.SdkManagerCli"
        : "com.android.sdklib.tool.AvdManagerCli",
      ...args,
    ],
  ];
}

export function sdkFor(project: MobileProject, emulator: boolean) {
  const variant = emulator
    ? `api-${project.api}-${project.abi}`
    : "device-tools";
  const sdk = join(project.home, toolchainVersion, host, variant);
  return sdkPaths(sdk, join(project.home, "user"));
}

export function findAdb(project: MobileProject) {
  // Prefer the host's own client so it uses the same protocol revision as an existing ADB server.
  return (
    executable("adb") ??
    [sdkFor(project, false).adb, sdkFor(project, true).adb].find(existsSync)
  );
}

async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(
  home: string,
  archive: { url: string; sha256: string },
  signal: AbortSignal,
) {
  const cache = join(home, "downloads");
  mkdirSync(cache, { recursive: true });
  const name = basename(new URL(archive.url).pathname);
  const final = join(cache, name);
  if (existsSync(final) && (await sha256(final)) === archive.sha256)
    return final;
  const temp = mkdtempSync(join(cache, ".download-"));
  const file = join(temp, name);
  try {
    console.log(`Downloading ${name}`);
    const response = await fetch(archive.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
    });
    if (!response.ok || !response.body)
      throw new Error(
        `Download failed with HTTP ${response.status} for ${archive.url}.`,
      );
    await Bun.write(file, response);
    if ((await sha256(file)) !== archive.sha256)
      throw new Error(
        `SHA-256 mismatch for ${name}. The archive was discarded.`,
      );
    // A Windows rename may reject an existing destination. A concurrent successful download is equivalent.
    if (existsSync(final) && (await sha256(final)) === archive.sha256)
      return final;
    renameSync(file, final);
    return final;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function missingArchiveTool() {
  return (windows ? ["tar"] : ["tar", "unzip"]).find(
    (tool) => !executable(tool),
  );
}

async function unpack(file: string, root: string, signal: AbortSignal) {
  mkdirSync(root, { recursive: true });
  if (file.endsWith(".zip") && !windows)
    return requireCommand("unzip", ["-q", file, "-d", root], {
      signal,
      timeout: 120_000,
    });
  return requireCommand("tar", ["-xf", file, "-C", root], {
    signal,
    timeout: 120_000,
  });
}

export async function prepareSdk(
  project: MobileProject,
  emulator: boolean,
  flags: MobileFlags,
  signal: AbortSignal,
) {
  const sdk = sdkFor(project, emulator);
  if (
    existsSync(join(sdk.sdk, "installed")) &&
    existsSync(sdk.adb) &&
    (!emulator || existsSync(sdk.emulator))
  )
    return sdk;
  const manifest = toolchains[host];
  if (!manifest)
    throw new Error(
      `Forge's portable Android SDK does not support ${host}. A connected device can still use a compatible adb on PATH.`,
    );
  const missing = missingArchiveTool();
  if (missing)
    throw new Error(
      `Install the host's ${missing} command to unpack verified SDK archives.`,
    );
  const packages = [
    "platform-tools",
    ...(emulator ? ["emulator", project.image] : []),
  ];
  console.log(
    `Install verified Android command-line tools and Temurin 17 under ${sdk.sdk}.`,
  );
  console.log(
    `Android SDK packages: ${packages.join(", ")}. Allow approximately ${emulator ? "12 GB" : "1 GB"} of disk space.`,
  );
  const interactive = Boolean(process.stdin.isTTY && !flags.yes);
  if (!flags["accept-licenses"] && !interactive)
    throw new Error(
      "Read https://developer.android.com/studio/terms and rerun with --yes --accept-licenses to approve the download and SDK licenses.",
    );
  if (
    interactive &&
    !confirm(
      "Download these tools and continue to the Android SDK license prompts?",
    )
  )
    return;
  if (!flags.yes && !interactive)
    throw new Error("Pass --yes to confirm non-interactive mobile setup.");
  signal.throwIfAborted();

  const [tools, jdk] = await Promise.all([
    download(project.home, manifest.tools, signal),
    download(project.home, manifest.jdk, signal),
  ]);
  mkdirSync(dirname(sdk.sdk), { recursive: true });
  mkdirSync(sdk.user, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(sdk.sdk), ".sdk-"));
  try {
    const target = sdkPaths(join(staging, "sdk"), sdk.user);
    const toolsDir = join(staging, "tools");
    const javaDir = join(staging, "java");
    await unpack(tools, toolsDir, signal);
    await unpack(jdk, javaDir, signal);
    mkdirSync(join(target.sdk, "cmdline-tools"), { recursive: true });
    renameSync(
      join(toolsDir, "cmdline-tools"),
      join(target.sdk, "cmdline-tools", "latest"),
    );
    const extractedJdk = readdirSync(javaDir).find((entry) =>
      entry.startsWith("jdk-"),
    );
    if (!extractedJdk)
      throw new Error("The Temurin archive did not contain a JDK.");
    renameSync(join(javaDir, extractedJdk), join(target.sdk, "jdk"));

    const sdkRoot = `--sdk_root=${target.sdk}`;
    await requireCommand(
      ...sdkCommand(target, "sdkmanager", [sdkRoot, "--licenses"]),
      {
        env: target.env,
        inherit: true,
        input: flags["accept-licenses"] ? "y\n".repeat(80) : undefined,
        signal,
        timeout: 5 * 60_000,
      },
    );
    // sdkmanager verifies the package archive checksums against Google's SDK repository metadata.
    await requireCommand(
      ...sdkCommand(target, "sdkmanager", [sdkRoot, ...packages]),
      {
        env: target.env,
        inherit: true,
        input: "",
        signal,
        timeout: 30 * 60_000,
      },
    );
    if (!existsSync(target.adb) || (emulator && !existsSync(target.emulator)))
      throw new Error(
        "Android SDK setup did not install all requested packages.",
      );
    writeFileSync(
      join(target.sdk, "installed"),
      JSON.stringify({ manifest: toolchainVersion, packages }, null, 2) + "\n",
    );
    try {
      renameSync(target.sdk, sdk.sdk);
    } catch (error) {
      if (!existsSync(join(sdk.sdk, "installed"))) throw error;
    }
    if (!existsSync(join(sdk.sdk, "installed")))
      throw new Error(`Incomplete SDK already exists at ${sdk.sdk}.`);
    console.log(`Android tools ready in ${sdk.sdk}`);
    return sdk;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function expoGoApk(project: MobileProject, signal: AbortSignal) {
  const archive = expoGo[project.sdk];
  if (!archive)
    throw new Error(
      `No verified Expo Go APK is bundled for SDK ${project.sdk}. Install the matching Expo Go from https://expo.dev/go or pass a development APK.`,
    );
  return download(project.home, archive, signal);
}
