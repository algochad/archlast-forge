// The docs as Markdown: `<page>.md` for every page (what "Copy page" copies), and `llms.txt`, the index of them. Made on the server from the
// same document and site the page renders, so they say the same; guides are their own MDX, front matter left out. No React in here.
import { deref, parametersOf, pickMedia, scopesOf, securityOf, serverUrlOf, type Arranged, type OpEntry, type OpenApi, type Schema } from "./openapi";
import { describe, mediaExample, show } from "./schema";
import { buildRequest, curl } from "./samples";
import type { DocPage, Site, Target } from "./site";

/** Where a target's Markdown is: `<base>/index.md` for the overview, `<base><page>.md` for the others (anchors aside). */
export const markdownUrl = (publicBase: string, t: Pick<Target, "page">) => `${publicBase}${t.page || "/index"}.md`;

const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

function fields(doc: OpenApi, schema: Schema | undefined, depth = 0, seen: string[] = []): string[] {
  const info = describe(doc, schema, seen);
  if (info.children?.kind !== "props" || depth > 3) return [];
  const out: string[] = [];
  for (const [name, s] of info.children.props) {
    const d = describe(doc, s, info.seen);
    const notes = [info.children.required.has(name) ? "required" : "", d.enumValues?.length ? `one of ${d.enumValues.map((e) => `\`${show(e.value)}\``).join(", ")}` : "", ...d.constraints.map(([k, v]) => `${k} ${v}`)].filter(Boolean);
    out.push(`${"  ".repeat(depth)}- \`${name}\` (${d.type}${notes.length ? `, ${notes.join(", ")}` : ""})${d.description ? `: ${cell(d.description)}` : ""}`);
    out.push(...fields(doc, s, depth + 1, d.seen));
  }
  return out;
}

function operationMarkdown(doc: OpenApi, e: OpEntry, origin: string, level: number): string {
  const h = (n: number) => "#".repeat(Math.min(6, level + n));
  const lines: string[] = [`${h(0)} ${e.op.summary ?? e.operationId}`, "", `\`${e.method.toUpperCase()} ${serverUrlOf(doc, e, origin)}${e.path}\``, ""];
  if (e.op.deprecated) lines.push("**Deprecated.**", "");
  if (e.op.description) lines.push(e.op.description.trim(), "");
  const security = securityOf(doc, e.op).filter((r) => Object.keys(r).length);
  if (security.length) {
    const scopes = scopesOf(doc, e.op);
    lines.push(`${h(1)} Authorizations`, "", ...security.map((r) => `- ${Object.keys(r).map((s) => `\`${s}\``).join(" and ")}`), ...(scopes.length ? ["", `Scopes: ${scopes.map((s) => `\`${s}\``).join(" ")}`] : []), "");
  }
  for (const where of ["path", "query", "header", "cookie"] as const) {
    const list = parametersOf(doc, e).filter((p) => p.in === where);
    if (!list.length) continue;
    lines.push(`${h(1)} ${where[0]!.toUpperCase()}${where.slice(1)} parameters`, "", "| Name | Type | Required | Description |", "|---|---|---|---|");
    for (const p of list) lines.push(`| \`${p.name}\` | ${cell(describe(doc, p.schema ?? pickMedia(p.content)?.[1].schema).type)} | ${p.required || where === "path" ? "yes" : "no"} | ${cell(p.description)} |`);
    lines.push("");
  }
  const body = deref(doc, e.op.requestBody);
  const media = pickMedia(body?.content);
  if (body && media) {
    lines.push(`${h(1)} Body`, "", `\`${media[0]}\`${body.required ? ", required" : ""}`, "");
    if (body.description) lines.push(body.description.trim(), "");
    const list = fields(doc, media[1].schema);
    if (list.length) lines.push(...list, "");
  }
  const responses = Object.entries(e.op.responses ?? {});
  if (responses.length) {
    lines.push(`${h(1)} Responses`, "");
    for (const [status, raw] of responses) {
      const r = deref(doc, raw) ?? {};
      lines.push(`- \`${status}\`${r.description ? `: ${cell(r.description)}` : ""}`);
      for (const c of (e.op["x-error-codes"] ?? []).filter((c) => c.status === status)) lines.push(`  - \`${c.code}\`${c.description ? `: ${cell(c.description)}` : ""}`);
    }
    lines.push("");
    const ok = responses.find(([s]) => s.startsWith("2"));
    const okMedia = ok && pickMedia(deref(doc, ok[1])?.content);
    const example = okMedia ? mediaExample(doc, okMedia[1], "response") : undefined;
    if (example !== undefined) lines.push(`${h(2)} Example response (${ok![0]})`, "", "```json", JSON.stringify(example, null, 2), "```", "");
  }
  lines.push(`${h(1)} Example request`, "", "```bash", curl(buildRequest(doc, e, origin)), "```", "");
  return lines.join("\n");
}

function overviewMarkdown(doc: OpenApi, model: Arranged, origin: string): string {
  const lines = [`# ${doc.info.title}`, "", `Version ${doc.info.version}`, ""];
  if (doc.info.summary) lines.push(doc.info.summary, "");
  if (doc.info.description) lines.push(doc.info.description.trim(), "");
  if (doc.servers?.length || origin) lines.push("## Base URL", "", ...(doc.servers?.length ? doc.servers.map((s) => `- \`${serverUrlOf(doc, { op: { servers: [s] }, pathItem: {} }, origin)}\`${s.description ? `: ${cell(s.description)}` : ""}`) : [`- \`${origin}\``]), "");
  if (model.schemes.length) {
    lines.push("## Authentication", "");
    for (const [name, s] of model.schemes) {
      lines.push(`- \`${name}\` (${s.type === "http" ? `HTTP ${s.scheme ?? ""}`.trim() : s.type})${s.description ? `: ${cell(s.description)}` : ""}`);
      for (const flow of Object.values(s.flows ?? {})) for (const [scope, d] of Object.entries(flow?.scopes ?? {})) lines.push(`  - \`${scope}\`: ${cell(d)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface MarkdownInput {
  doc: OpenApi;
  model: Arranged;
  site: Site;
  /** The server's address, for URLs in examples when the document has no servers. */
  origin: string;
  publicBase: string;
  /** A guide's Markdown (its MDX without front matter), by slug. */
  guideSource: (slug: string) => string | undefined;
}

/** A page as Markdown. */
export function pageMarkdown(input: MarkdownInput, page: DocPage): string {
  const { doc, model, site, origin, publicBase } = input;
  const link = (t: Target, text: string) => `[${text}](${markdownUrl(publicBase, t)})`;
  switch (page.kind) {
    case "overview":
      return overviewMarkdown(doc, model, origin);
    case "guide":
      return `${(input.guideSource(page.guide!.slug) ?? "").trim()}\n`;
    case "operation":
      return operationMarkdown(doc, page.op!, origin, 1);
    case "tag": {
      const tag = page.tag!;
      const lines = [`# ${tag.title}`, ""];
      if (tag.description) lines.push(tag.description.trim(), "");
      if (site.mode === "tag") for (const o of tag.ops) lines.push(operationMarkdown(doc, o, origin, 2));
      else for (const o of tag.ops) lines.push(`- ${link(site.op.get(o)!, o.op.summary ?? o.operationId)}: \`${o.method.toUpperCase()} ${o.path}\``);
      return lines.join("\n") + "\n";
    }
    case "webhooks": {
      const lines = ["# Webhooks", ""];
      for (const w of model.webhooks) {
        lines.push(`## ${w.name}`, "");
        if (w.op.summary) lines.push(w.op.summary, "");
        if (w.op.description) lines.push(w.op.description.trim(), "");
        const media = pickMedia(deref(doc, w.op.requestBody)?.content);
        if (media) lines.push(...fields(doc, media[1].schema), "");
      }
      return lines.join("\n");
    }
    case "models": {
      const lines = ["# Models", ""];
      for (const m of model.models) {
        lines.push(`## ${m.name}`, "");
        const info = describe(doc, { $ref: `#/components/schemas/${encodeURIComponent(m.name)}` });
        if (info.description) lines.push(info.description.trim(), "");
        lines.push(...fields(doc, { $ref: `#/components/schemas/${encodeURIComponent(m.name)}` }), "");
      }
      return lines.join("\n");
    }
    case "single": {
      const parts = [overviewMarkdown(doc, model, origin)];
      for (const t of model.tags) {
        parts.push(`## ${t.title}`, t.description?.trim() ?? "");
        for (const o of t.ops) parts.push(operationMarkdown(doc, o, origin, 3));
      }
      return parts.join("\n\n");
    }
  }
}

/** `llms.txt`: the API's name and summary, then every page's Markdown with one line about it, by section. */
export function llmsTxt(input: MarkdownInput): string {
  const { doc, site, publicBase } = input;
  const lines = [`# ${doc.info.title}`, "", `> ${cell(doc.info.summary ?? doc.info.description?.split("\n")[0] ?? `The ${doc.info.title} reference, version ${doc.info.version}.`)}`, ""];
  const sections = new Map<string, DocPage[]>();
  for (const p of site.order) {
    const name = p.kind === "overview" || p.kind === "single" ? "Docs" : p.area === "guides" ? (p.section ?? "Guides") : p.kind === "operation" ? `API: ${p.section}` : "API";
    sections.set(name, [...(sections.get(name) ?? []), p]);
  }
  for (const [name, pages] of sections) {
    lines.push(`## ${name}`, "");
    for (const p of pages) lines.push(`- [${p.title}](${markdownUrl(publicBase, { page: p.path })})${p.summary ? `: ${cell(p.summary)}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
