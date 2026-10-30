// Docs site: a React app (src/main.tsx) that loads content/*.mdx page by page. Bun bundles it into dist/. `--serve` previews on :4000.
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mdx, searchIndex } from "./mdx";
import { reading, titleOf } from "./src/nav";

const dist = join(import.meta.dir, "dist");

async function build() {
  rmSync(dist, { recursive: true, force: true });
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, "index.html")], outdir: dist, publicPath: "/", splitting: true, minify: true, plugins: [mdx] });
  if (!out.success) {
    out.logs.forEach((l) => console.error(l));
    process.exit(1);
  }
  copyFileSync(join(dist, "index.html"), join(dist, "404.html")); // static hosts that serve 404.html for unknown paths then still load the app
  const rank = new Map(reading.map((s, i) => [titleOf(s), i])); // pages compile in any order; the file should not depend on it
  writeFileSync(join(dist, "search.json"), JSON.stringify(searchIndex.sort((a, b) => rank.get(a[0])! - rank.get(b[0])!)));
  console.log(`✓ built ${reading.length} pages and the landing page into ${dist}`);
}

await build();
if (process.argv.includes("--serve")) {
  const server = Bun.serve({
    port: 4000,
    async fetch(req) {
      const file = Bun.file(join(dist, new URL(req.url).pathname));
      return new Response((await file.exists()) ? file : Bun.file(join(dist, "index.html"))); // any other path is a client-side route
    },
  });
  console.log(`✓ docs on ${server.url}`);
}
