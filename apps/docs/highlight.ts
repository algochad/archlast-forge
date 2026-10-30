// Build-time syntax highlighting with Shiki. Both themes are emitted as CSS variables, so the page switches theme without re-rendering.
import { createHighlighter } from "shiki";

const LANGS = ["ts", "tsx", "bash", "json", "diff", "yaml", "toml", "vue", "svelte", "nginx", "ini", "dockerfile", "css", "html"] as const;
const hl = await createHighlighter({ themes: ["vitesse-light", "vitesse-dark"], langs: [...LANGS] });

/** A comment on the first line that names a file ("// forge/notes.ts: a query") becomes the block's title. */
const FILE = /^(?:\/\/|#) ?([\w@./[\]$-]+\.(?:tsx?|json|ya?ml|toml|css|md|env|sh|vue|svelte|ini))\b/;

/** The props of `<Code>`: the highlighted `<pre>` and the label for its header. */
export function highlight(rawLang: string | null | undefined, text: string, title?: string) {
  text = text.replace(/\n$/, "");
  const lang = rawLang && (LANGS as readonly string[]).includes(rawLang) ? rawLang : rawLang === "sh" || rawLang === "shell" ? "bash" : "text";
  const html = hl.codeToHtml(text, { lang, themes: { light: "vitesse-light", dark: "vitesse-dark" }, defaultColor: false });
  return { html, label: title ?? FILE.exec(text)?.[1] ?? (lang === "text" ? "" : lang) };
}
