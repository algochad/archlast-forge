// Bun plugin that compiles content/*.mdx. A remark plugin gives headings their ids, highlights code at build time, points
// page links at routes, and collects the headings and the text under each for the outline and the search index.
import { compile } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import { basename } from "node:path";
import { highlight } from "./highlight";
import type { Heading } from "./src/doc";
import { isSlug, titleOf } from "./src/nav";

/** One entry per heading, for the search box: [page, heading, url, text]. Filled while the pages compile. */
export const searchIndex: [string, string, string, string][] = [];

const PHRASING = new Set(["paragraph", "heading", "emphasis", "strong", "delete", "link", "tableCell"]);
const text = (n: any): string => n.value ?? n.children?.map(text).join(PHRASING.has(n.type) ? "" : " ") ?? "";
const parts = (n: any): Heading["parts"] => (n.type === "inlineCode" ? [{ code: n.value }] : n.value !== undefined ? [n.value] : n.children.flatMap(parts));
const walk = (n: any, f: (n: any) => void) => (f(n), n.children?.forEach((c: any) => walk(c, f)));
const PAGE_LINK = /^([\w-]+)\.html(#.*)?$/;

function remarkDocs(opts: { slug: string; headings: Heading[] }) {
  const { slug, headings } = opts;
  if (!isSlug(slug)) throw new Error(`content/${slug}.mdx is not in PAGES`);
  const title = titleOf(slug);
  return (tree: any) => {
    const ids = new Map<string, number>();
    let chunk: { heading: string; id: string; text: string[] } | undefined;
    const flush = () => chunk && searchIndex.push([title, chunk.heading, `/${slug}#${chunk.id}`, chunk.text.join(" ").replace(/\s+/g, " ").trim().slice(0, 1200)]);
    for (const block of tree.children) {
      if (block.type === "heading" && block.depth <= 3) {
        const heading = text(block);
        const base = heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
        const seen = ids.get(base) ?? 0; // a repeated heading gets -1, -2, ... like GitHub's
        ids.set(base, seen + 1);
        const id = seen ? `${base}-${seen}` : base;
        block.data = { hProperties: { id } };
        headings.push({ depth: block.depth, id, parts: parts(block) });
        flush();
        chunk = { heading, id, text: [] };
      } else chunk?.text.push(text(block));
    }
    flush();

    walk(tree, (n) => {
      if (n.type === "link") {
        const m = PAGE_LINK.exec(n.url);
        if (m) {
          if (m[1] !== "index" && !isSlug(m[1])) throw new Error(`${slug}.mdx links to ${n.url}, which is not a page`);
          n.url = `${m[1] === "index" ? "/" : `/${m[1]}`}${m[2] ?? ""}`;
        }
      } else if (n.type === "code") {
        const { html, label } = highlight(n.lang, n.value);
        const attr = (name: string, value: string) => ({ type: "mdxJsxAttribute", name, value });
        for (const k of ["lang", "meta", "value"]) delete n[k];
        Object.assign(n, { type: "mdxJsxFlowElement", name: "Code", attributes: [attr("html", html), attr("label", label)], children: [] });
      }
    });
  };
}

export const mdx: Bun.BunPlugin = {
  name: "mdx",
  setup(build) {
    build.onLoad({ filter: /\.mdx$/ }, async ({ path }) => {
      const headings: Heading[] = [];
      const file = await compile(await Bun.file(path).text(), { remarkPlugins: [remarkGfm, [remarkDocs, { slug: basename(path, ".mdx"), headings }]] });
      return { contents: `${file}\nexport const headings = ${JSON.stringify(headings)};`, loader: "js" };
    });
  },
};
