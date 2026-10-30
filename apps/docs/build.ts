// Docs site: a React app (src/main.tsx) that loads content/*.mdx page by page. Bun bundles it into dist/, and static.tsx adds the HTML, Markdown and
// llms.txt files for readers without JavaScript. `--serve` previews on :4000. SITE_URL=https://docs.example.com adds canonical links and a sitemap.
import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mdx, searchIndex } from "./mdx";
import { reading, titleOf } from "./src/nav";
import { writeStatic } from "./static";

const dist = join(import.meta.dir, "dist");

async function build() {
  rmSync(dist, { recursive: true, force: true });
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, "index.html")], outdir: dist, publicPath: "/", splitting: true, minify: true, plugins: [mdx] });
  if (!out.success) {
    out.logs.forEach((l) => console.error(l));
    process.exit(1);
  }
  const rank = new Map(reading.map((s, i) => [titleOf(s), i])); // pages compile in any order; the file should not depend on it
  writeFileSync(join(dist, "search.json"), JSON.stringify(searchIndex.sort((a, b) => rank.get(a[0])! - rank.get(b[0])!)));
  await writeStatic(dist); // after search.json: it compiles the pages once more
  console.log(`✓ built ${reading.length} pages and the landing page into ${dist}`);
}

await build();
if (process.argv.includes("--serve")) {
  const server = Bun.serve({
    port: 4000,
    async fetch(req) {
      const path = join(dist, decodeURIComponent(new URL(req.url).pathname));
      const file = [path, join(path, "index.html")].find((p) => p.startsWith(dist) && statSync(p, { throwIfNoEntry: false })?.isFile()); // a page is a folder with an index.html
      return file ? new Response(Bun.file(file)) : new Response(Bun.file(join(dist, "404.html")), { status: 404 });
    },
  });
  console.log(`✓ docs on ${server.url}`);
}
