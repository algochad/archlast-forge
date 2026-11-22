// Android archives and SHA-256s from https://developer.android.com/studio#command-line-tools-only.
// JDK archive SHA-256s from the Adoptium release API (Temurin 17.0.21.1+2).
type Archive = { url: string; sha256: string };
type Toolchain = { tools: Archive; jdk: Archive };

const toolsVersion = "15859902";
const jdkVersion = "17.0.21.1";
const jdkBuild = "2";

function android(host: string, sha256: string): Archive {
  return {
    url: `https://dl.google.com/android/repository/commandlinetools-${host}-${toolsVersion}_latest.zip`,
    sha256,
  };
}

function temurin(os: string, arch: string, sha256: string): Archive {
  const format = os === "windows" ? "zip" : "tar.gz";
  return {
    url: `https://github.com/adoptium/temurin17-binaries/releases/download/jdk-${jdkVersion}%2B${jdkBuild}/OpenJDK17U-jdk_${arch}_${os}_hotspot_${jdkVersion}_${jdkBuild}.${format}`,
    sha256,
  };
}

const jdkLinux = temurin(
  "linux",
  "x64",
  "0b0ac5eab6db6abaec68c9913bcddb31321e5da411c45073d520d9c125e6f7b4",
);

export const toolchains: Record<string, Toolchain> = {
  "linux-x64": {
    tools: android(
      "linux",
      "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
    ),
    jdk: jdkLinux,
  },
  "darwin-x64": {
    tools: android(
      "mac_x86_64",
      "c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3",
    ),
    jdk: temurin(
      "mac",
      "x64",
      "63a1469b52a8063a9f70e539f815093f3a33ef71e6f901b5f43545dbe4e72858",
    ),
  },
  "darwin-arm64": {
    tools: android(
      "mac_arm64",
      "835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e",
    ),
    jdk: temurin(
      "mac",
      "aarch64",
      "2a88ccb044a8fb00957be93245da6357c11b55717511509d147cbcc5d93b2109",
    ),
  },
  "win32-x64": {
    tools: android(
      "win",
      "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a",
    ),
    jdk: temurin(
      "windows",
      "x64",
      "eafba0944f777abdc74d5aad16049c9b5a1275b6ce99e2939ba9f7f3e6f08c87",
    ),
  },
};

// The official Expo Go release for Android on SDK 58. GitHub publishes the
// SHA-256 in the Expo-Go-58.0.5 release's asset metadata.
export const expoGo: Record<number, Archive> = {
  58: {
    url: "https://github.com/expo/expo-go-releases/releases/download/Expo-Go-58.0.5/Expo-Go-58.0.5.apk",
    sha256: "d979cf81c56c5432c5aa69adc9497521ee72d1f87e92eee33bc949167a40f1a6",
  },
};

export const toolchainVersion = `tools-${toolsVersion}-jdk-${jdkVersion}-${jdkBuild}`;
