// Ours, not a patch. scripts/update-scalar.ts copies scalar/entry.ts, this file and src/api-docs/contract.ts into
// packages/api-client/forge-explorer/ of the patched upstream checkout (keeping their relative paths) and runs
// `vite build -c forge-explorer/scalar/vite.config.ts` there, with upstream's own dependencies (Vue plugin, Tailwind, Vite).
//
// The result is ONE classic script (explorer.js, an IIFE that defines window.ForgeExplorer) and ONE stylesheet (explorer.css), both
// minified, plus licenses.json: every third-party package that ended up in the script, so the build can write THIRD_PARTY_NOTICES.md and
// refuse a licence the engine can't ship.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import svgLoader from "vite-svg-loader";
import { defineConfig, type Plugin } from "vite";

const here = import.meta.dirname; // packages/api-client/forge-explorer/scalar
const client = resolve(here, "../.."); // packages/api-client
const { version } = JSON.parse(readFileSync(join(client, "package.json"), "utf8"));

interface Found {
  name: string;
  version: string;
  license: unknown;
  repository: unknown;
  author: unknown;
  dir: string;
}

/** The package.json (with a name) that owns a module file, following pnpm's symlinks. */
function packageOf(file: string): Found | undefined {
  let dir = dirname(realpathSync(file));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      if (json.name) return { name: json.name, version: json.version ?? "", license: json.license ?? json.licenses, repository: json.repository, author: json.author, dir };
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "license", "license.md", "COPYING", "NOTICE"];

/** Writes licenses.json beside the bundle: the packages that contributed code to it, with their licence files and rendered size. */
function licenses(): Plugin {
  return {
    name: "forge-licenses",
    generateBundle(_options, bundle) {
      const seen = new Map<string, Found & { bytes: number; files: { file: string; text: string }[] }>();
      const add = (file: string, bytes: number, viaMap = true) => {
        if (file.startsWith("\0") || !existsSync(file)) return;
        // Upstream's workspace packages ship dist files with their own dependencies already inlined (@scalar/code-highlight has
        // highlight.js, lowlight and the unified stack in its chunks): the .map beside such a file names the packages inside it.
        if (viaMap && existsSync(`${file}.map`)) {
          try {
            const map = JSON.parse(readFileSync(`${file}.map`, "utf8")) as { sources?: string[]; sourceRoot?: string };
            for (const source of map.sources ?? []) add(resolve(dirname(file), map.sourceRoot ?? "", source), 0, false);
          } catch {}
        }
        const found = packageOf(file);
        if (!found) return;
        const key = `${found.name}@${found.version}`;
        const known = seen.get(key);
        if (known) return void (known.bytes += bytes);
        const files = LICENSE_FILES.map((f) => join(found.dir, f))
          .filter((f) => existsSync(f))
          .map((f) => ({ file: f.slice(found.dir.length + 1), text: readFileSync(f, "utf8") }));
        seen.set(key, { ...found, bytes, files });
      };
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        // The modules Rolldown rendered (not the ones tree-shaken away)...
        for (const [id, mod] of Object.entries(chunk.modules ?? {})) {
          const bytes = (mod as { renderedLength?: number }).renderedLength ?? 0;
          if (bytes > 0) add(id.replace(/\?.*$/, ""), bytes);
        }
      }
      const list = [...seen.values()].map(({ dir, ...rest }) => ({ ...rest, workspace: !dir.includes("node_modules") }));
      this.emitFile({ type: "asset", fileName: "licenses.json", source: JSON.stringify(list.sort((a, b) => a.name.localeCompare(b.name)), null, 1) });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [vue(), tailwindcss(), svgLoader(), licenses()],
  define: {
    "process.env.NODE_ENV": '"production"',
    PACKAGE_VERSION: JSON.stringify(version),
    // What window.ForgeExplorer.version says: set by scripts/update-scalar.ts ("scalar <release> + N patches").
    FORGE_EXPLORER_VERSION: JSON.stringify(process.env.FORGE_EXPLORER_VERSION ?? "scalar (unpinned build)"),
  },
  resolve: {
    alias: { "@": resolve(client, "src"), "@v2": resolve(client, "src/v2") },
    dedupe: ["vue"],
  },
  build: {
    outDir: resolve(here, "../dist"),
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    reportCompressedSize: false,
    lib: { entry: resolve(here, "entry.ts"), formats: ["iife"], name: "ForgeExplorerBundle", fileName: () => "explorer.js", cssFileName: "explorer" },
    rolldownOptions: {
      // Like upstream's own library builds: nothing but stylesheets is kept for its side effects, so what the entry doesn't reach is dropped.
      treeshake: { moduleSideEffects: (id: string) => id.includes(".css") },
    },
  },
});
