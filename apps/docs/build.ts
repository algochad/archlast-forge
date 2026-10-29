// Static docs site: content/*.md → dist/*.html with Bun's Markdown renderer and Shiki. `--serve` previews on :4000.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { highlightAll } from "./highlight";
import { GITHUB, escape, icons, page, topbar } from "./layout";
import { landing } from "./landing";

const ORDER = [
  ["introduction", "Introduction"],
  ["concepts", "How it works"],
  ["getting-started", "Getting started"],
  ["tutorial", "Tutorial: a notes app"],
  ["framework", "Full-stack apps"],
  ["backend", "Backends"],
  ["schema", "Schema and validators"],
  ["functions", "Functions"],
  ["queries", "Reading data"],
  ["reactivity", "Reactivity"],
  ["caching", "Caching"],
  ["auth", "Authentication"],
  ["storage", "File storage"],
  ["http", "HTTP endpoints"],
  ["scheduling", "Scheduling and crons"],
  ["errors", "Errors"],
  ["migrations", "Migrations and data"],
  ["testing", "Testing"],
  ["clients", "Clients: React, Vue, Svelte"],
  ["recipes", "Recipes"],
  ["cli", "CLI reference"],
  ["deployment", "Deployment"],
  ["configuration", "Configuration"],
  ["dashboard", "Dashboard"],
  ["limits", "Limits and security"],
  ["reference", "API reference"],
  ["troubleshooting", "Troubleshooting"],
] as const;

/** The sidebar's sections, in reading order. Every page in ORDER must be in exactly one. */
const GROUPS: [string, string[]][] = [
  ["Start", ["introduction", "concepts", "getting-started", "tutorial"]],
  ["Build", ["framework", "backend", "schema", "functions", "queries", "reactivity", "caching", "auth", "storage", "http", "scheduling", "errors", "migrations", "testing", "clients", "recipes"]],
  ["Run", ["cli", "deployment", "configuration", "dashboard", "limits"]],
  ["Reference", ["reference", "troubleshooting"]],
];
const reading = GROUPS.flatMap(([, slugs]) => slugs);
if (reading.length !== ORDER.length || ORDER.some(([s]) => reading.filter((g) => g === s).length !== 1)) throw new Error("GROUPS and ORDER list different pages");
const titles: Record<string, string> = Object.fromEntries(ORDER);
const groupOf = (slug: string) => GROUPS.find(([, slugs]) => slugs.includes(slug))![0];

const dist = join(import.meta.dir, "dist");

const plain = (html: string) =>
  html
    .replace(/<div class="code-head">[\s\S]*?<\/button><\/div>/g, " ")
    .replace(/<\/?(?:span|code|a|strong|em|mark|b|i)\b[^>]*>/g, "") // inline tags: no gap, or a code token breaks apart
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

type Heading = { level: number; id: string; html: string };
const HEADING = /<h([1-3]) id="([^"]+)"><a href="#[^"]+">([\s\S]*?)<\/a><\/h\1>/g;

/** One entry per heading, for the search box: [page, heading, url, text]. */
const searchIndex: [string, string, string, string][] = [];

function build() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  for (const slug of reading) {
    const title = titles[slug]!;
    const md = readFileSync(join(import.meta.dir, "content", `${slug}.md`), "utf8");
    let body = Bun.markdown.html(md, { headings: true, autolinks: true });
    body = highlightAll(body).replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, "</table></div>");

    const headings: Heading[] = [...body.matchAll(HEADING)].map((m) => ({ level: Number(m[1]), id: m[2]!, html: m[3]! }));
    const toc = headings.filter((h) => h.level > 1);

    // Search entries: the text from each heading to the next.
    const marks = [...body.matchAll(HEADING)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, id: m[2]!, text: plain(m[3]!) }));
    marks.forEach((m, i) => {
      const text = plain(body.slice(m.end, marks[i + 1]?.at ?? body.length));
      searchIndex.push([title, m.text, `${slug}.html#${m.id}`, text.slice(0, 1200)]);
    });
    const description = plain(/<p>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? title).slice(0, 180);

    const i = reading.indexOf(slug);
    const prev = reading[i - 1];
    const next = reading[i + 1];
    const link = (s: string) => `<a href="${s}.html"${s === slug ? ' aria-current="page"' : ""}>${escape(titles[s]!)}</a>`;
    const sidebar = `<aside class="side" id="sidebar" aria-label="Docs">${GROUPS.map(([name, slugs]) => `<div class="group"><div class="group-name">${name}</div>${slugs.map(link).join("")}</div>`).join("")}</aside>`;
    const tocHtml = toc.length
      ? `<aside class="toc" aria-label="On this page"><div class="toc-in"><div class="toc-title">On this page</div>${toc.map((h) => `<a href="#${h.id}" class="l${h.level}">${h.html}</a>`).join("")}</div></aside>`
      : "";
    const pager = `<nav class="pager" aria-label="Pages">${prev ? `<a class="prev" href="${prev}.html"><small>Previous</small><span>${escape(titles[prev]!)}</span></a>` : "<span></span>"}${next ? `<a class="next" href="${next}.html"><small>Next</small><span>${escape(titles[next]!)}</span></a>` : "<span></span>"}</nav>`;

    const main = `<main id="content" class="doc"><article>
      <div class="crumbs"><a href="index.html">Home</a><span>/</span><span>${groupOf(slug)}</span><span>/</span><span aria-current="page">${escape(title)}</span></div>
      <div class="prose">${body}</div>
      <div class="edit"><a href="${GITHUB}/edit/master/apps/docs/content/${slug}.md" rel="noopener">Edit this page on GitHub ${icons.arrow}</a></div>
      ${pager}
    </article></main>`;

    writeFileSync(
      join(dist, `${slug}.html`),
      page({ title: `${title} · archlast-forge`, description, bodyClass: "docs", body: `${topbar(`${slug}.html`)}<div class="scrim" data-close-menu></div><div class="shell">${sidebar}${main}${tocHtml}</div>` }),
    );
  }

  const footerCols = GROUPS.map(([name, slugs]): [string, [string, string][]] => [name, slugs.map((s) => [titles[s]!, `${s}.html`])]);
  writeFileSync(join(dist, "index.html"), landing(footerCols));
  writeFileSync(join(dist, "search.json"), JSON.stringify(searchIndex));
  for (const f of ["style.css", "site.js", "landing.css", "landing.js"]) copyFileSync(join(import.meta.dir, f), join(dist, f));
  mkdirSync(join(dist, "fonts"), { recursive: true });
  const fonts = join(import.meta.dir, "node_modules/@fontsource-variable");
  copyFileSync(join(fonts, "geist/files/geist-latin-wght-normal.woff2"), join(dist, "fonts/geist.woff2"));
  copyFileSync(join(fonts, "geist-mono/files/geist-mono-latin-wght-normal.woff2"), join(dist, "fonts/geist-mono.woff2"));
  console.log(`✓ built ${ORDER.length} pages and the landing page into ${dist}`);
}

build();
if (process.argv.includes("--serve")) {
  const server = Bun.serve({ port: 4000, fetch: (req) => new Response(Bun.file(join(dist, new URL(req.url).pathname.slice(1) || "index.html"))) });
  console.log(`✓ docs on ${server.url}`);
}
