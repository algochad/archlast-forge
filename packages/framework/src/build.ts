import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { classifyApp, type ComponentReport } from "./classify";
import { generate } from "./generate";
import { scanRoutes } from "./routes";

export interface BuildManifest {
  version: string;
  dev: boolean;
  /** Files below client/, served under /_app/. */
  entry: string;
  css: string[];
  /** Per route id: the files to preload when that route is part of the page. */
  routes: Record<string, string[]>;
  /** The server bundle, relative to the build directory. */
  server: string;
  /**
   * Present when pages are rendered with islands (see classify.ts): the browser entry that hydrates them, the files to preload with it, and the routes
   * (ids) that can be rendered that way. A page whose routes are not all in `routes` is rendered and hydrated as a whole, as without islands.
   */
  islands?: { entry: string; preload: string[]; routes: string[] };
}

export interface BuildResult {
  manifest: BuildManifest;
  /** <root>/.forge/build/<version> */
  dir: string;
}

/** A failed build, with every error in one message. */
export class BuildError extends Error {}

type Meta = { outputs: Record<string, { entryPoint?: string; imports?: { path: string; kind: string }[]; cssBundle?: string }> };

const messageOf = (logs: unknown[]) =>
  logs
    .map((l) => {
      const log = l as { message?: string; position?: { file?: string; line?: number; column?: number } | null };
      const at = log.position?.file ? `${log.position.file}:${log.position.line}:${log.position.column}\n  ` : "";
      return `${at}${log.message ?? String(l)}`;
    })
    .join("\n\n");

/** Server bundles don't carry styles; the browser build does. */
const ignoreStyles: Bun.BunPlugin = { name: "ignore-styles", setup(b) {
    b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
  },
};

/** Tailwind CSS v4 for projects that install Tailwind's Bun plugin (`bun add -d tailwindcss bun-plugin-tailwind`); projects without it build as before. */
async function tailwind(root: string): Promise<Bun.BunPlugin[]> {
  let path: string;
  try {
    path = Bun.resolveSync("bun-plugin-tailwind", root);
  } catch {
    return [];
  }
  return [(await import(path)).default];
}

/** The id of an island in the page: its file below app/ and the name it is exported under. */
const islandId = (appDir: string, m: ComponentReport) => `${relative(appDir, m.file).split(sep).join("/")}#${m.exportName}`;

/**
 * Server bundles see each island's file through a wrapper module that exports the same names, the islands marked (island.tsx). The browser bundle
 * imports the files as they are.
 */
const WRAPPED = "?forge-island";

function islandWrappers(appDir: string, mounts: ComponentReport[]): Bun.BunPlugin {
  const byFile = new Map<string, ComponentReport[]>();
  for (const m of mounts) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  return {
    name: "forge-islands",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.namespace === "forge-island" || args.kind === "entry-point-build" || !args.importer) return undefined;
        let file: string;
        try {
          file = Bun.resolveSync(args.path, args.resolveDir || dirname(args.importer));
        } catch {
          return undefined;
        }
        // The wrapper's own import is for the file itself.
        if (args.importer.endsWith(WRAPPED)) return undefined;
        // A different path from the file's: the bundler would take a module of that path in another namespace for the same module.
        return byFile.has(file) ? { path: file + WRAPPED, namespace: "forge-island" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "forge-island" }, (args) => {
        const path = args.path.slice(0, -WRAPPED.length);
        const file = JSON.stringify(path);
        const lines = [`import { island } from "@archlast/forge-framework/island";`, `export * from ${file};`];
        // Under other names than the exports', so the bundler does not take the wrapper for the thing it wraps.
        (byFile.get(path) ?? []).forEach((m, i) => {
          const id = JSON.stringify(islandId(appDir, m));
          lines.push(`import { ${m.exportName} as original${i} } from ${file};`, `const wrapped${i} = island(original${i}, ${id});`, m.exportName === "default" ? `export default wrapped${i};` : `export { wrapped${i} as ${m.exportName} };`);
        });
        return { contents: lines.join("\n"), loader: "js", resolveDir: dirname(path) };
      });
    },
  };
}

const flat = (p: string) => p.replace(/^\.\//, "");

const buildDirOf = (root: string) => join(root, ".forge", "build");

/** Reads the build `buildApp` left behind: production starts from it. */
export function readBuild(root: string): BuildResult | undefined {
  const latest = join(buildDirOf(root), "latest.json");
  if (!existsSync(latest)) return undefined;
  const { version } = JSON.parse(readFileSync(latest, "utf8")) as { version: string };
  const dir = join(buildDirOf(root), version);
  return existsSync(join(dir, "manifest.json")) ? { manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), dir } : undefined;
}

/** Writes gzip and brotli copies of text assets, which the server hands out as they are. */
function precompress(clientDir: string) {
  for (const file of readdirSync(clientDir)) {
    if (!/\.(js|css|svg|json|html|txt|map)$/.test(file)) continue;
    const bytes = readFileSync(join(clientDir, file));
    if (bytes.length < 1024) continue;
    writeFileSync(join(clientDir, `${file}.gz`), gzipSync(bytes, { level: 9 }));
    writeFileSync(join(clientDir, `${file}.br`), brotliCompressSync(bytes));
  }
}

/**
 * Bundles app/ twice: for the browser (split per route, hashed) and for the server (one file, packages left external).
 * Output goes to <root>/.forge/build/<version>; `latest.json` points at the newest. Throws BuildError.
 */
export async function buildApp(o: { root: string; dev: boolean; islands?: boolean }): Promise<BuildResult> {
  const root = resolve(o.root);
  const { dev } = o;
  const appDir = join(root, "app");
  if (!existsSync(appDir)) throw new BuildError(`No app/ directory in ${root}. Framework mode needs app/routes/ (and optionally app/root.tsx).`);
  let tree;
  try {
    tree = scanRoutes(appDir);
  } catch (e) {
    throw new BuildError((e as Error).message);
  }
  const gen = generate(root, tree);

  // Islands: only when the root layout and document can be left unhydrated (see classify.ts); otherwise the app is rendered as it always was.
  let mounts: ComponentReport[] = [];
  let islandRoutes: string[] = [];
  const wantIslands = o.islands ?? process.env.FORGE_ISLANDS === "1";
  if (wantIslands) {
    const report = classifyApp(root);
    const layout = tree.root ? report.components.find((c) => c.name === "Layout" && c.file === join(appDir, tree.root!)) : undefined;
    const why = !report.root
      ? undefined
      : report.root.tier !== "page"
        ? `the root layout (app/root.tsx) is ${report.root.tier === "island" ? "an island" : "a fallback"}: ${report.components.find((c) => c.name === report.root!.component)?.reasons[0] ?? ""}`
        : report.root.notes.includes("exports authPlugins")
          ? "app/root.tsx exports authPlugins, which islands do not load yet"
          : layout && layout.tier !== "page"
            ? "the document (Layout in app/root.tsx) is interactive"
            : undefined;
    if (why) console.log(`[archlast-forge] islands are off: ${why}`);
    else {
      mounts = report.mounts;
      islandRoutes = report.routes.filter((r) => r.tier !== "fallback").map((r) => r.id);
    }
  }
  const appRoot = join(root, "app");
  if (mounts.length) {
    writeFileSync(
      join(gen, "islands.client.ts"),
      `// Generated by archlast-forge. Don't edit.
import { startIslands } from "@archlast/forge-framework/islands";

startIslands({
${mounts.map((m) => `  ${JSON.stringify(islandId(appRoot, m))}: () => import(${JSON.stringify(relative(gen, m.file).split(sep).join("/").replace(/\.(tsx|ts|jsx|js)$/, ""))}).then((m) => m.${m.exportName === "default" ? "default" : m.exportName}),`).join("\n")}
});
`,
    );
  }

  const version = Date.now().toString(36);
  const dir = join(buildDirOf(root), version);
  const common = { root, publicPath: "/_app/", sourcemap: dev ? ("linked" as const) : ("none" as const), drop: dev ? [] : ["debugger"], throw: false };

  const client = await Bun.build({
    ...common,
    entrypoints: [join(gen, "entry.client.tsx"), ...(mounts.length ? [join(gen, "islands.client.ts")] : [])],
    outdir: join(dir, "client"),
    target: "browser",
    splitting: true,
    minify: !dev,
    naming: "[name]-[hash].[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    plugins: await tailwind(root),
    metafile: true,
  });
  if (!client.success) throw new BuildError(`The browser bundle failed to build:\n\n${messageOf(client.logs)}`);

  const server = await Bun.build({
    ...common,
    // Production: smaller and quicker to load, with names kept (identifiers aren't renamed) and a linked map so stack traces point at the source.
    minify: dev ? false : { whitespace: true, syntax: true },
    sourcemap: dev ? "inline" : "linked",
    entrypoints: [join(gen, "routes.server.ts")],
    outdir: join(dir, "server"),
    target: "bun",
    packages: "external",
    naming: "[name]-[hash].[ext]",
    plugins: [ignoreStyles, ...(mounts.length ? [islandWrappers(appRoot, mounts)] : [])],
  });
  if (!server.success) throw new BuildError(`The server bundle failed to build:\n\n${messageOf(server.logs)}`);

  const meta = (client as unknown as { metafile: Meta }).metafile;
  const byName = new Map(Object.entries(meta.outputs).map(([path, info]) => [flat(path), info]));
  const entryOf = (name: string) => client.outputs.find((a) => a.kind === "entry-point" && basename(a.path).startsWith(`${name}-`));
  const entryOut = entryOf("entry.client");
  if (!entryOut) throw new BuildError("The browser bundle has no entry point");
  const entry = basename(entryOut.path);

  // A route's preload list: its own chunk and everything that chunk imports statically.
  const preload = (name: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(name)) return seen;
    seen.add(name);
    for (const i of byName.get(name)?.imports ?? []) if (i.kind === "import-statement" && byName.has(flat(i.path))) preload(flat(i.path), seen);
    return seen;
  };
  const routes: Record<string, string[]> = {};
  const visit = (rs: typeof tree.routes) => {
    for (const r of rs) {
      const own = [...byName].find(([, info]) => info.entryPoint && resolve(info.entryPoint) === join(appDir, r.file))?.[0];
      if (own) routes[r.id] = [...preload(own)];
      if (r.children) visit(r.children);
    }
  };
  visit(tree.routes);

  const css = [flat(byName.get(entry)?.cssBundle ?? "")].filter(Boolean);
  const serverOut = server.outputs.find((a) => a.kind === "entry-point");
  if (!serverOut) throw new BuildError("The server bundle has no entry point");

  const islandsOut = mounts.length ? entryOf("islands.client") : undefined;
  const manifest: BuildManifest = {
    version,
    dev,
    entry,
    css,
    routes,
    server: `server/${basename(serverOut.path)}`,
    ...(islandsOut && { islands: { entry: basename(islandsOut.path), preload: [...preload(basename(islandsOut.path))], routes: islandRoutes } }),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(buildDirOf(root), { recursive: true });
  writeFileSync(join(buildDirOf(root), "latest.json"), JSON.stringify({ version }));
  if (!dev) precompress(join(dir, "client"));

  // Keep the previous build in dev: a page loaded before the rebuild still asks for its files.
  const keep = new Set([version, ...(dev ? readdirSync(buildDirOf(root)).filter((n) => n !== version && !n.endsWith(".json")).sort().slice(-1) : [])]);
  for (const name of readdirSync(buildDirOf(root))) if (!name.endsWith(".json") && !keep.has(name)) rmSync(join(buildDirOf(root), name), { recursive: true, force: true });
  return { manifest, dir };
}
