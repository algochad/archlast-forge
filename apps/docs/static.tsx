// What the build adds to dist/ for readers that don't run JavaScript, which is most crawlers and agents: every page as HTML with its text in
// it, as Markdown (`/<page>.md`, with its section and the previous and next page at the top, so an agent can walk the docs), the llms.txt
// files (https://llmstxt.org: the index, everything in one file, one file per section; `/index.md` is the index too), robots.txt and, when
// SITE_URL is set, sitemap.xml.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { mdx } from "./mdx";
import { Article, NotFound, Sidebar } from "./src/Doc";
import { GITHUB, GROUPS, PAGES, groupOf, reading, titleOf, type Slug } from "./src/nav";
import { DESCRIPTIONS, TASKS, sectionId } from "./summaries";

Bun.plugin(mdx); // the pages import as modules here too. That compiles them again and adds to `searchIndex`, which build.ts has written by now

const SITE = (process.env.SITE_URL ?? "").replace(/\/+$/, ""); // "" leaves links root-relative and the sitemap out
if (SITE && !/^https?:\/\/[^/]+$/.test(SITE)) throw new Error(`SITE_URL must be an origin like https://docs.example.com (got ${SITE})`);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const plain = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

/** The page as Markdown: its source, with links to other pages pointing at their Markdown. */
const markdown = (slug: Slug) =>
  readFileSync(join(import.meta.dir, "content", `${slug}.mdx`), "utf8").replace(/\]\(([\w-]+)\.html(#[^)]*)?\)/g, (_, page, hash = "") => `](${SITE}${page === "index" ? "/" : `/${page}.md`}${hash})`);

export async function writeStatic(dist: string) {
  const shell = readFileSync(join(dist, "index.html"), "utf8");
  const summary = /<meta name="description" content="(.*?)" \/>/.exec(shell)?.[1];
  if (!summary) throw new Error("index.html has no meta description");
  const write = (file: string, text: string) => (mkdirSync(join(dist, file, ".."), { recursive: true }), writeFileSync(join(dist, file), text));
  const render = (path: string, node: React.ReactNode) => renderToStaticMarkup(<StaticRouter location={path}>{node}</StaticRouter>);

  /** The built index.html with this page's head and the text in place of the empty root, which the app replaces once it loads. */
  function html(o: { title: string; description: string; path: string; body: React.ReactNode; md?: string; hidden?: boolean }) {
    let out = shell;
    const swap = (from: RegExp, to: string) => {
      if (!from.test(out)) throw new Error(`index.html no longer matches ${from}`);
      out = out.replace(from, () => to);
    };
    swap(/<title>.*?<\/title>/, `<title>${esc(o.title)}</title>`);
    for (const [pattern, tag] of [[/<meta name="description" content=".*?" \/>/, 'name="description"'], [/<meta property="og:description" content=".*?" \/>/, 'property="og:description"']] as const)
      swap(pattern, `<meta ${tag} content="${esc(o.description)}" />`);
    swap(/<meta property="og:title" content=".*?" \/>/, `<meta property="og:title" content="${esc(o.title)}" />`);
    swap(/<div id="root"><\/div>/, `<div id="root">${render(o.path, o.body)}</div>`);
    swap(
      /<\/head>/,
      [
        SITE && !o.hidden ? `<link rel="canonical" href="${SITE}${o.path}" />\n    <meta property="og:url" content="${SITE}${o.path}" />` : "",
        o.md ? `<link rel="alternate" type="text/markdown" href="${SITE}${o.md}" />` : "",
        `<link rel="alternate" type="text/plain" href="${SITE}/llms.txt" title="llms.txt" />`,
        o.hidden ? `<meta name="robots" content="noindex" />` : "",
      ].filter(Boolean).map((tag) => `\n    ${tag}`).join("") + "\n  </head>",
    );
    return out;
  }
  const layout = (children: React.ReactNode) => (
    <div className="shell">
      <Sidebar />
      <main id="content" className="doc">{children}</main>
    </div>
  );

  const md = Object.fromEntries(reading.map((s) => [s, markdown(s)])) as Record<Slug, string>;
  /** The page's Markdown with its place in the docs under the title and its source at the end: an agent that only follows Markdown links can walk every page. */
  const withNav = (slug: Slug) => {
    const at = reading.indexOf(slug);
    const [prev, next] = [reading[at - 1], reading[at + 1]];
    const top = [`Section: ${groupOf(slug)}`, `[All pages](${SITE}/index.md)`, `[Web page](${SITE}/${slug})`].join(" · ");
    const around = [prev && `Previous: [${titleOf(prev)}](${SITE}/${prev}.md)`, next && `Next: [${titleOf(next)}](${SITE}/${next}.md)`].filter(Boolean).join(" · ");
    const head = md[slug].replace(/^(# .*)\n/, (_, h) => `${h}\n\n> ${top}\n> ${around}\n`);
    if (head === md[slug]) throw new Error(`${slug}.mdx doesn't start with a "# Title" line`);
    return `${head.trimEnd()}\n\n---\n\n${around}\n\nSource: ${GITHUB}/blob/master/apps/docs/content/${slug}.mdx\n`;
  };
  for (const slug of reading) {
    const mod = await PAGES[slug][1]();
    write(`${slug}.md`, withNav(slug));
    write(`${slug}/index.html`, html({ title: `${titleOf(slug)} · archlast-forge`, description: DESCRIPTIONS[slug], path: `/${slug}`, md: `/${slug}.md`, body: layout(<Article slug={slug} Content={mod.default} />) }));
  }

  write(
    "index.html",
    html({
      title: /<title>(.*?)<\/title>/.exec(shell)![1]!,
      description: summary,
      path: "/",
      body: layout(
        <article>
          <div className="prose">
            <h1>archlast-forge</h1>
            <p>{summary}</p>
            <p>Start with <a href="/getting-started">Getting started</a>, or read how it works in <a href="/concepts">How it works</a>. The pages are listed on the left.</p>
            <p>For language models: <a href="/llms.txt">llms.txt</a> lists the pages, <a href="/llms-full.txt">llms-full.txt</a> has all of them in one file, and every page is Markdown at <code>/&lt;page&gt;.md</code>.</p>
          </div>
        </article>,
      ),
    }),
  );
  write("404.html", html({ title: "Page not found · archlast-forge", description: "This page does not exist.", path: "/404", hidden: true, body: <NotFound /> }));

  const link = (s: Slug) => `- [${titleOf(s)}](${SITE}/${s}.md): ${DESCRIPTIONS[s]}`;
  const sections = GROUPS.map(([name, slugs]) => ({ name, slugs, file: `/llms-${sectionId(name)}.txt` }));
  // The index, as llms.txt and as /index.md: what the project is, how to read the docs, where to start for a task, then every page by section.
  const index = [
    "# archlast-forge",
    "",
    `> ${plain(summary)} It runs as one container on your own servers and needs Bun 1.4.4 or later.`,
    "",
    "- You write the backend in `forge/`: `schema.ts` (tables), function files (queries, mutations, actions), `http.ts` (HTTP routes and optional NestJS), `auth.ts`, `crons.ts`. `archlast-forge codegen` writes `forge/_generated`, the typed `api` that clients import.",
    "- Frontend code (`app/` in a full-stack app, `src/` in a separate frontend) imports only from `forge/_generated`, never other `forge/` files.",
    "- Two project modes: a full-stack app (React pages with file routes, rendered by the engine) or a backend (the engine plus Postgres, Redis and S3 as one container stack, for any frontend). A monorepo holds several apps, and services call each other over Forge RPC.",
    "- One deployment per app, self-hosted. MIT licensed.",
    "",
    "## How to read these docs",
    "",
    "- Every page is Markdown at `/<page>.md` (HTML at `/<page>`). Request a page's address with `Accept: text/markdown` to get Markdown instead of HTML.",
    "- Each page opens with its section and links to the previous and next page and back to this index, and its links point at other pages' Markdown, so the docs can be walked from any page.",
    `- [All the documentation in one file](${SITE}/llms-full.txt) is every page in reading order. One file per section is listed under Optional.`,
    "",
    "## For AI coding agents",
    "",
    `- Install the skill with \`npx skills add algochad/archlast-forge\`: the rules, folder layouts, scaffolding and CLI an agent needs to build on archlast-forge, each pointing back to the pages below for detail. See [Agent skill](${SITE}/agent-skill.md).`,
    `- Source, issues and the pages as \`.mdx\`: ${GITHUB} (\`apps/docs/content/<page>.mdx\`).`,
    "",
    "## Start here by task",
    "",
    ...TASKS.map(([task, pages]) => `- ${task}: ${pages.map((s) => `[${titleOf(s)}](${SITE}/${s}.md)`).join(", ")}`),
    "",
    ...GROUPS.flatMap(([name, slugs]) => [`## ${name}`, "", ...slugs.map(link), ""]),
    "## Optional",
    "",
    `- [All the documentation in one file](${SITE}/llms-full.txt): every page above, in reading order`,
    ...sections.map(({ name, slugs, file }) => `- [${name}, in one file](${SITE}${file}): ${slugs.map(titleOf).join(", ")}`),
    "",
  ].join("\n");
  write("llms.txt", index);
  write("index.md", index);
  const bundle = (heading: string, slugs: Slug[]) =>
    [`# ${heading}\n\n> ${plain(summary)}`, ...slugs.map((s) => md[s].replace(/^(# .*)\n/, (_, h) => `${h}\n\nSource: ${SITE}/${s}\n`))].join("\n\n---\n\n") + "\n";
  write("llms-full.txt", bundle("archlast-forge documentation", reading));
  for (const { name, slugs, file } of sections) write(file.slice(1), bundle(`archlast-forge documentation: ${name}`, slugs));
  write("robots.txt", ["User-agent: *", "Allow: /", "", "# For language models: /llms.txt (also /index.md) lists the pages, /llms-full.txt is all of them, /llms-<section>.txt is one section, and every page is Markdown at /<page>.md", ...(SITE ? ["", `Sitemap: ${SITE}/sitemap.xml`] : []), ""].join("\n"));
  if (SITE) write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["", ...reading.map((s) => `/${s}`)].map((p) => `  <url><loc>${SITE}${p || "/"}</loc></url>`).join("\n")}\n</urlset>\n`);

  // The build fails rather than ship a page a reader can't read.
  for (const slug of reading) {
    const page = readFileSync(join(dist, slug, "index.html"), "utf8");
    if (!page.includes("<h1") || !page.includes(`href="/${slug}.md"`)) throw new Error(`${slug}/index.html is missing its text or its Markdown link`);
    const text = readFileSync(join(dist, `${slug}.md`), "utf8");
    if (!text.includes("[All pages](") || !/(Previous|Next): \[/.test(text)) throw new Error(`${slug}.md has no navigation`);
  }
  const listed = readFileSync(join(dist, "llms.txt"), "utf8");
  for (const slug of reading) if (!listed.includes(`/${slug}.md)`)) throw new Error(`llms.txt does not list ${slug}`);
  for (const { file, slugs } of sections) {
    const text = readFileSync(join(dist, file), "utf8");
    if (!listed.includes(`${file})`) || slugs.some((s) => !text.includes(`Source: ${SITE}/${s}\n`))) throw new Error(`${file} is not listed in llms.txt, or misses a page`);
  }
  if (readFileSync(join(dist, "index.md"), "utf8") !== listed) throw new Error("index.md and llms.txt differ");
}
