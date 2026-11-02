// The page the desktop app shows in client mode, built into dist/ before `tauri build` (tauri.conf.json): minified, with FORGE_URL, the
// backend it talks to, in config.js.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = join(import.meta.dir, "..");
const url = process.env.FORGE_URL;
if (!url) throw new Error("Set FORGE_URL to the backend this app talks to: FORGE_URL=https://api.example.com bun run build");
rmSync(join(here, "dist"), { recursive: true, force: true });
const result = await Bun.build({ entrypoints: [join(here, "index.html")], outdir: join(here, "dist"), minify: true, define: { "process.env.NODE_ENV": '"production"' } });
if (!result.success) throw new AggregateError(result.logs, "The page didn't build");
writeFileSync(join(here, "dist", "config.js"), `window.FORGE_URL = ${JSON.stringify(url)};\n`);
console.log(`✓ dist/ talks to ${url}`);
