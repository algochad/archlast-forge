// What the build adds to dist/ for readers that don't run JavaScript, which is most crawlers and agents: every page as HTML with its text in
// it, as Markdown (`/<page>.md`), the llms.txt files (https://llmstxt.org), robots.txt and, when SITE_URL is set, sitemap.xml.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { mdx } from "./mdx";
import { Article, NotFound, Sidebar } from "./src/Doc";
import { GROUPS, PAGES, reading, titleOf, type Slug } from "./src/nav";

Bun.plugin(mdx); // the pages import as modules here too. That compiles them again and adds to `searchIndex`, which build.ts has written by now

const SITE = (process.env.SITE_URL ?? "").replace(/\/+$/, ""); // "" leaves links root-relative and the sitemap out
if (SITE && !/^https?:\/\/[^/]+$/.test(SITE)) throw new Error(`SITE_URL must be an origin like https://docs.example.com (got ${SITE})`);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const plain = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

/** The page as Markdown: its source, with links to other pages pointing at their Markdown. */
const markdown = (slug: Slug) =>
  readFileSync(join(import.meta.dir, "content", `${slug}.mdx`), "utf8").replace(/\]\(([\w-]+)\.html(#[^)]*)?\)/g, (_, page, hash = "") => `](${SITE}${page === "index" ? "/" : `/${page}.md`}${hash})`);

/** The first paragraph after the title, cut to about a sentence: the note under each link in llms.txt and the page's meta description. */
function describe(md: string, fallback: string) {
  const para = md.split(/\n\s*\n/).map((b) => b.trim()).find((b) => b && !/^(#|```|\||[-*] |\d+\. |>)/.test(b));
  const text = plain(para ?? fallback);
  const sentence = /^.{60,200}?[.!?](?=\s|$)/.exec(text)?.[0]; // the first sentence that says something
  return sentence ?? (text.length <= 200 ? text : text.slice(0, 160).replace(/\s+\S*$/, "") + "…");
}

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
  for (const slug of reading) {
    const mod = await PAGES[slug][1]();
    write(`${slug}.md`, md[slug]);
    write(`${slug}/index.html`, html({ title: `${titleOf(slug)} · archlast-forge`, description: describe(md[slug], titleOf(slug)), path: `/${slug}`, md: `/${slug}.md`, body: layout(<Article slug={slug} Content={mod.default} />) }));
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

  const link = (s: Slug) => `- [${titleOf(s)}](${SITE}/${s}.md): ${describe(md[s], titleOf(s))}`;
  write(
    "llms.txt",
    [
      "# archlast-forge",
      "",
      `> ${plain(summary)} It runs as one container on your own servers and needs Bun 1.4.3 or later.`,
      "",
      "Every page below is Markdown. Add `.md` to a page's address to get its source. `llms-full.txt` has all of them in one file.",
      "",
      ...GROUPS.flatMap(([name, slugs]) => [`## ${name}`, "", ...slugs.map(link), ""]),
      "## Optional",
      "",
      `- [All the documentation in one file](${SITE}/llms-full.txt): every page above, in reading order`,
      "",
    ].join("\n"),
  );
  write(
    "llms-full.txt",
    [`# archlast-forge documentation\n\n> ${plain(summary)}`, ...reading.map((s) => md[s].replace(/^(# .*)\n/, (_, h) => `${h}\n\nSource: ${SITE}/${s}\n`))].join("\n\n---\n\n") + "\n",
  );
  write("robots.txt", ["User-agent: *", "Allow: /", "", "# For language models: /llms.txt lists the pages, /llms-full.txt is all of them, and every page is Markdown at /<page>.md", ...(SITE ? ["", `Sitemap: ${SITE}/sitemap.xml`] : []), ""].join("\n"));
  if (SITE) write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["", ...reading.map((s) => `/${s}`)].map((p) => `  <url><loc>${SITE}${p || "/"}</loc></url>`).join("\n")}\n</urlset>\n`);

  // The build fails rather than ship a page a reader can't read.
  for (const slug of reading) {
    const page = readFileSync(join(dist, slug, "index.html"), "utf8");
    if (!page.includes("<h1") || !page.includes(`href="/${slug}.md"`)) throw new Error(`${slug}/index.html is missing its text or its Markdown link`);
  }
  const index = readFileSync(join(dist, "llms.txt"), "utf8");
  for (const slug of reading) if (!index.includes(`/${slug}.md)`)) throw new Error(`llms.txt does not list ${slug}`);
}
