// Static docs site: content/*.md → dist/*.html with Bun's Markdown renderer. `--serve` previews on :4000.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORDER = [
  ["index", "Introduction"],
  ["getting-started", "Getting started"],
  ["schema", "Schema and validators"],
  ["functions", "Functions"],
  ["queries", "Reading data"],
  ["reactivity", "Reactivity"],
  ["caching", "Caching"],
  ["auth", "Authentication"],
  ["storage", "File storage"],
  ["scheduling", "Scheduling and crons"],
  ["errors", "Errors"],
  ["migrations", "Migrations and data"],
  ["testing", "Testing"],
  ["clients", "Clients: React, Vue, Svelte"],
  ["cli", "CLI reference"],
  ["deployment", "Deployment"],
  ["configuration", "Configuration"],
  ["dashboard", "Dashboard"],
  ["limits", "Limits and security"],
] as const;

const dist = join(import.meta.dir, "dist");
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function build() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const [slug, title] of ORDER) {
    const md = readFileSync(join(import.meta.dir, "content", `${slug}.md`), "utf8");
    const body = Bun.markdown.html(md, { headings: true, autolinks: true });
    const nav = ORDER.map(([s, t]) => `<a href="${s}.html"${s === slug ? ' aria-current="page"' : ""}>${escape(t)}</a>`).join("");
    writeFileSync(
      join(dist, `${slug}.html`),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · archlast-forge</title><link rel="stylesheet" href="style.css"></head><body><a class="skip" href="#content">Skip to content</a><header><a class="brand" href="index.html">archlast-forge</a></header><div class="layout"><nav aria-label="Docs">${nav}</nav><main id="content">${body}</main></div></body></html>`,
    );
  }
  writeFileSync(join(dist, "style.css"), readFileSync(join(import.meta.dir, "style.css")));
  console.log(`✓ built ${ORDER.length} pages into ${dist}`);
}

build();
if (process.argv.includes("--serve")) {
  const server = Bun.serve({ port: 4000, fetch: (req) => new Response(Bun.file(join(dist, new URL(req.url).pathname.slice(1) || "index.html"))) });
  console.log(`✓ docs on ${server.url}`);
}
