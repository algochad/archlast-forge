// Build-time syntax highlighting with Shiki. Both themes are emitted as CSS variables, so the page switches theme without re-rendering.
import { createHighlighter } from "shiki";

const LANGS = ["ts", "tsx", "bash", "json", "diff", "yaml", "toml", "vue", "svelte", "nginx", "ini", "dockerfile", "css", "html"] as const;
const hl = await createHighlighter({ themes: ["github-light", "github-dark"], langs: [...LANGS] });

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A comment on the first line that names a file ("// forge/notes.ts: a query") becomes the block's title. */
const FILE = /^(?:\/\/|#) ?([\w@./[\]$-]+\.(?:tsx?|json|ya?ml|toml|css|md|env|sh|vue|svelte|ini))\b/;

export function codeBlock(rawLang: string | undefined, text: string, title?: string) {
  text = text.replace(/\n$/, "");
  const lang = rawLang && (LANGS as readonly string[]).includes(rawLang) ? rawLang : rawLang === "sh" || rawLang === "shell" ? "bash" : "text";
  const html = hl.codeToHtml(text, { lang, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false });
  const label = title ?? FILE.exec(text)?.[1] ?? (lang === "text" ? "" : lang);
  return `<div class="code${label ? " titled" : ""}"><div class="code-head">${label ? `<span class="code-title">${escape(label)}</span>` : ""}<button type="button" class="copy" aria-label="Copy code">Copy</button></div>${html}</div>`;
}

/** Replaces the plain `<pre><code>` blocks in rendered Markdown. */
export function highlightAll(html: string) {
  return html.replace(/<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_, lang, code) => codeBlock(lang, decode(code)));
}

