// A safe subset of Markdown for the descriptions in the OpenAPI document: paragraphs, headings, lists, quotes, fenced code, tables, code spans,
// links, emphasis. Everything else is text, and nothing from the document becomes HTML: this builds React elements, and a link's address must be
// http, https, mailto or have no scheme at all.
import { Fragment, type ReactNode } from "react";

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; items: Block[][] }
  | { t: "quote"; blocks: Block[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "hr" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
const isRule = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("|");

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) => FENCE.test(l) || /^\s{0,3}#{1,6}\s/.test(l) || ITEM.test(l) || /^\s{0,3}>/.test(l) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ t: "quote", blocks: parse(body.join("\n")) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const indent = item[1]!.length;
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
        const body = [m[3]!];
        for (i++; i < lines.length; i++) {
          const l = lines[i]!;
          const next = ITEM.exec(l);
          if (next && next[1]!.length <= indent) break;
          if (!l.trim()) {
            // A blank line stays in the item only when an indented line follows.
            if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !(ITEM.exec(lines[i + 1]!) && ITEM.exec(lines[i + 1]!)![1]!.length <= indent)) {
              body.push("");
              continue;
            }
            break;
          }
          if (!/^\s/.test(l) && startsBlock(l)) break;
          body.push(l.replace(new RegExp(`^\\s{0,${indent + 2}}`), ""));
        }
        items.push(parse(body.join("\n")));
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) rows.push(cells(lines[i]!));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const text: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && (text.length === 0 || !startsBlock(lines[i]!)); i++) text.push(lines[i]!);
    blocks.push({ t: "p", text: text.join("\n") });
  }
  return blocks;
}

/** Whether a link may be followed: no scheme (a path or a fragment), or http, https, mailto. */
export function safeUrl(url: string): boolean {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  return !scheme || ["http", "https", "mailto"].includes(scheme[1]!.toLowerCase());
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[((?:[^\[\]]|\[[^\]]*\])+)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|\*\*(?=\S)([\s\S]+?)\*\*|(?<!\w)__(?=\S)([\s\S]+?)__(?!\w)|\*(?=[^\s*])([\s\S]+?)\*|(?<!\w)_(?=[^\s_])([\s\S]+?)_(?!\w)|~~(?=\S)([\s\S]+?)~~/g;

function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const push = (node: ReactNode) => out.push(<Fragment key={`${key}${n++}`}>{node}</Fragment>);
  const plain = (s: string) => {
    const parts = s.split(/ {2,}\n|\\\n/);
    parts.forEach((p, i) => {
      if (i) push(<br />);
      if (p) push(p.replace(/\n/g, " "));
    });
  };
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) plain(text.slice(last, m.index));
    last = m.index + m[0].length;
    const k = `${key}${n}.`;
    if (m[2] !== undefined) push(<code>{m[2].replace(/^ (.*) $/, "$1")}</code>);
    else if (m[3] !== undefined) {
      const href = m[4]!;
      if (safeUrl(href)) {
        const external = /^https?:/i.test(href);
        push(
          <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {inline(m[3], k)}
          </a>,
        );
      } else push(inline(m[3], k));
    } else if (m[5] !== undefined)
      push(
        <a href={m[5]} target="_blank" rel="noopener noreferrer">
          {m[5]}
        </a>,
      );
    else if (m[6] !== undefined || m[7] !== undefined) push(<strong>{inline((m[6] ?? m[7])!, k)}</strong>);
    else if (m[8] !== undefined || m[9] !== undefined) push(<em>{inline((m[8] ?? m[9])!, k)}</em>);
    else push(<del>{inline(m[10]!, k)}</del>);
  }
  if (last < text.length) plain(text.slice(last));
  return out;
}

function render(blocks: Block[], base: number, key = ""): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}${i}`;
    switch (b.t) {
      case "p":
        return <p key={k}>{inline(b.text, `${k}.`)}</p>;
      case "h": {
        const Tag = `h${Math.min(6, base + b.level - 1)}` as "h1";
        return <Tag key={k}>{inline(b.text, `${k}.`)}</Tag>;
      }
      case "code":
        return (
          <pre key={k}>
            <code {...(b.lang ? { className: `language-${b.lang}` } : {})}>{b.text}</code>
          </pre>
        );
      case "list": {
        const List = b.ordered ? "ol" : "ul";
        return (
          <List key={k}>
            {b.items.map((item, j) => (
              <li key={j}>{render(item, base, `${k}.${j}.`)}</li>
            ))}
          </List>
        );
      }
      case "quote":
        return <blockquote key={k}>{render(b.blocks, base, `${k}.`)}</blockquote>;
      case "table":
        return (
          <div className="fd-table" key={k}>
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j}>{inline(c, `${k}.h${j}.`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, j) => (
                      <td key={j}>{inline(c, `${k}.${r}.${j}.`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={k} />;
    }
  });
}

/** Markdown text from the document. `headings` is the level a `#` becomes (a description sits below the operation's own heading). */
export function Markdown({ text, headings = 4, className }: { text: string | undefined; headings?: number; className?: string }) {
  if (!text?.trim()) return null;
  return <div className={className ? `fd-md ${className}` : "fd-md"}>{render(parse(text), headings)}</div>;
}

/** One line of Markdown (a summary, a parameter's note) as inline elements. */
export function Inline({ text }: { text: string | undefined }) {
  return text ? <>{inline(text)}</> : null;
}

/** The text without its markup, for search. */
export const plainText = (md: string) => md.replace(/```[\s\S]*?```/g, " ").replace(/[`*_#>|~]|\[([^\]]*)\]\([^)]*\)/g, " $1 ").replace(/\s+/g, " ").trim();
