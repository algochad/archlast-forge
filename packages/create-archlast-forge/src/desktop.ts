// apps/desktop: a Tauri app. `full` runs the full-stack app's own engine on the user's machine (Bun as a sidecar, no Docker); `client` is a
// page that talks to a forge backend elsewhere.
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const DESKTOP_MODES = ["full", "client"] as const;
export type DesktopMode = (typeof DESKTOP_MODES)[number];

const TEMPLATE = new URL("../template/desktop", import.meta.url).pathname;
const TAURI = "^2.12.4";

const MODE_SECTION: Record<DesktopMode, (main: string) => string> = {
  full: () => `**Full mode**: the app runs \`apps/web\` itself, engine included, on this computer, with no Docker and no server to reach. Bun (shipped
inside the app, as a sidecar) starts \`desktop-engine.ts\`, which starts the engine in production mode on a free port of \`127.0.0.1\`
(never on the network), with its database and a secret of its own in the app's data folder; the window opens on it once it answers, and
the engine stops when the app quits. \`scripts/bundle-engine.ts\` prepares what ships (it runs before \`tauri dev\` and \`tauri build\`):
\`apps/web\` built for production with its production dependencies, the starter, and Bun itself (\`src-tauri/binaries\`).

The app carries Bun (about 90 MB) and the web app's dependencies, so an installer is a few hundred MB. Each user has their own data,
on their machine: there is nothing to deploy, and nothing shared between users.`,
  client: (main) => `**Client mode**: the app is a page (\`src/main.tsx\`, typed from \`apps/${main}\`) that talks to a forge backend running elsewhere.
Build it with the backend's address: \`FORGE_URL=https://api.example.com bun run build\`. In development it talks to
\`http://localhost:3000\` (\`config.js\`).

The backend must accept the app's origin: add \`tauri://localhost\` (macOS, Linux) and \`http://tauri.localhost\` (Windows) to its
\`TRUSTED_ORIGINS\`. Signing in from the app needs a session it can send: use Better Auth's bearer plugin and the client's \`headers\` option.`,
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A square RGBA PNG of one color: placeholder icons, until `tauri icon` makes real ones. */
export function solidPng(size: number, [r, g, b]: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, size);
  new DataView(header.buffer).setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits a channel, RGBA, no interlacing
  const row = new Uint8Array(1 + size * 4); // filter byte 0, then the pixels
  for (let x = 0; x < size; x++) row.set([r, g, b, 255], 1 + x * 4);
  const pixels = new Uint8Array(row.length * size);
  for (let y = 0; y < size; y++) pixels.set(row, y * row.length);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (png.set(p, at), at + p.length), 0);
  return png;
}

/** Writes apps/desktop into the monorepo at `root`, for the main app `main` (web or api). */
export function addDesktop(root: string, name: string, version: string, mode: DesktopMode, main: string) {
  if (mode === "full" && main !== "web") throw new Error("--desktop full runs the full-stack app on the user's machine: use --mode framework (or --desktop client for a backend)");
  const dir = join(root, "apps", "desktop");
  cpSync(TEMPLATE, dir, { recursive: true });
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore"));
  renameSync(join(dir, "src-tauri", `main.${mode}.rs`), join(dir, "src-tauri", "src", "main.rs"));
  const unused = mode === "full" ? ["src-tauri/main.client.rs", "index.html", "config.js", "src", "scripts/build-client.ts"] : ["src-tauri/main.full.rs", "engine", "loading", "scripts/bundle-engine.ts"];
  for (const p of unused) rmSync(join(dir, p), { recursive: true, force: true });

  const fill = (path: string) => {
    for (const entry of readdirSync(path)) {
      const p = join(path, entry);
      if (statSync(p).isDirectory()) fill(p);
      else
        writeFileSync(
          p,
          readFileSync(p, "utf8")
            .replaceAll("__MODE_SECTION__", MODE_SECTION[mode](main))
            .replaceAll("__API__", `${main}Api`)
            .replaceAll("__NAME__", name)
            .replaceAll("__VERSION__", version),
        );
    }
  };
  fill(dir);

  const json = (path: string, value: unknown) => writeFileSync(join(dir, path), JSON.stringify(value, null, 2) + "\n");
  json("package.json", {
    name: `@${name}/desktop`,
    private: true,
    type: "module",
    scripts: { dev: "tauri dev", build: "tauri build", ...(mode === "client" && { "dev:page": "bun --port 5174 ./index.html" }) },
    ...(mode === "client" && {
      dependencies: { [`@${name}/api`]: "workspace:*", "@archlast/forge-react": `^${version}`, "@archlast/forge-runtime": `^${version}`, react: "^19.3.1", "react-dom": "^19.3.1" },
    }),
    devDependencies: { "@tauri-apps/cli": TAURI, ...(mode === "client" && { "@types/react": "^19.3.0", "@types/react-dom": "^19.3.0" }) },
  });
  json("src-tauri/tauri.conf.json", {
    $schema: "https://schema.tauri.app/config/2",
    productName: name,
    version: "0.1.0",
    identifier: `com.example.${name.replace(/[^a-z0-9]/g, "")}.desktop`,
    build:
      mode === "full"
        ? { beforeDevCommand: "bun scripts/bundle-engine.ts", beforeBuildCommand: "bun scripts/bundle-engine.ts", frontendDist: "../loading" }
        : { beforeDevCommand: "bun run dev:page", devUrl: "http://localhost:5174", beforeBuildCommand: "bun scripts/build-client.ts", frontendDist: "../dist" },
    // Full mode opens its window itself, on the engine's address, once it answers.
    app: { windows: mode === "full" ? [] : [{ title: name, width: 1200, height: 800 }], security: { csp: null } },
    bundle: {
      active: true,
      targets: "all",
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/icon.png"],
      ...(mode === "full" && { externalBin: ["binaries/bun"], resources: { "app-bundle/": "app/" } }),
    },
  });
  if (mode === "client")
    json("tsconfig.json", { compilerOptions: { target: "ES2023", lib: ["ES2023", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true, experimentalDecorators: true }, include: ["src"] });
  if (mode === "client") writeFileSync(join(dir, "src-tauri", "Cargo.toml"), readFileSync(join(dir, "src-tauri", "Cargo.toml"), "utf8").replace('tauri-plugin-shell = "2.6"\n', ""));
  mkdirSync(join(dir, "src-tauri", "icons"), { recursive: true });
  for (const [file, size] of [["32x32.png", 32], ["128x128.png", 128], ["icon.png", 512]] as const) writeFileSync(join(dir, "src-tauri", "icons", file), solidPng(size, [255, 91, 31]));
}
