// The docs as pages: what the page, the server (rendered pages, their Markdown, llms.txt) and the navigation agree on. Each page has an
// address below the docs' path; everything that can be linked to (an operation, a tag, a guide, a webhook, a model, the authentication) is a
// target: a page and an anchor on it. How the reference is split depends on `layout.pages`. No React in here.
import type { DocsPageConfig } from "./contract";
import type { Arranged, ModelEntry, OpEntry, TagSection, WebhookEntry } from "./openapi";
import { slug } from "./openapi";

/** A page of the app's own prose, as far as the site needs it. */
export interface SiteGuide {
  slug: string;
  title: string;
  group?: string;
  order?: number;
}

export type PageKind = "overview" | "guide" | "tag" | "operation" | "webhooks" | "models" | "single";

export interface DocPage {
  /** The address below the docs' path: "" for the overview, "/guides/quickstart", "/products/create-product". */
  path: string;
  kind: PageKind;
  title: string;
  /** What the page is in, for the breadcrumb and the tabs: a guide group, a tag group, "Webhooks". */
  section?: string;
  /** Which tab the page belongs to. */
  area: "guides" | "reference";
  /** One line about it, for llms.txt. */
  summary?: string;
  guide?: SiteGuide;
  tag?: TagSection;
  op?: OpEntry;
}

export interface Target {
  page: string;
  /** The element on that page, "" for its top. */
  anchor: string;
}

export interface Site {
  mode: "operation" | "tag" | "single";
  pages: DocPage[];
  byPath: Map<string, DocPage>;
  /** Reading order, for previous and next. */
  order: DocPage[];
  op: Map<OpEntry, Target>;
  tag: Map<TagSection, Target>;
  guide: Map<string, Target>;
  webhook: Map<WebhookEntry, Target>;
  model: Map<ModelEntry, Target>;
  webhooks: Target | null;
  models: Target | null;
  authentication: Target | null;
  overview: Target;
  /** The addresses of 0.19's single page (`#/payments/createPayment`), for links made before pages had addresses of their own. */
  legacy: Map<string, Target>;
}

/** An operation id as the end of an address: createProduct is "create-product", payments:create is "payments-create". */
export const opSlug = (operationId: string) =>
  operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "operation";

/** Guides in their order, grouped by their `group` in order of first appearance; those with none are under `fallback`. */
export function guideGroups<G extends SiteGuide>(guides: G[], fallback: string): { title: string; guides: G[] }[] {
  const sorted = guides.map((g, i) => [g, i] as const).sort(([a, i], [b, j]) => (a.order ?? Infinity) - (b.order ?? Infinity) || i - j).map(([g]) => g);
  const out = new Map<string, G[]>();
  for (const g of sorted) out.set(g.group ?? fallback, [...(out.get(g.group ?? fallback) ?? []), g]);
  return [...out].map(([title, list]) => ({ title, guides: list }));
}

/** First segments a tag can't take, because the docs' own pages and files are there. */
const RESERVED = new Set(["guides", "webhooks", "models", "_docs", "explorer", "index", "llms", "authentication", "openapi"]);

export interface SiteOptions {
  pages?: "operation" | "tag" | "single";
  referencePath?: string;
  hide?: DocsPageConfig["hide"];
  labels: { overview: string; guides: string; webhooks: string; models: string; api: string };
}

/** The pages of the document and the guides, with their addresses. */
export function buildSite(model: Arranged, guides: SiteGuide[], o: SiteOptions): Site {
  const mode = o.pages ?? "operation";
  const ref = (o.referencePath ?? "").replace(/\/+$/, "").replace(/^(?!\/|$)/, "/");
  const pages: DocPage[] = [];
  const add = (p: DocPage) => (pages.push(p), p);
  const site: Site = {
    mode,
    pages,
    byPath: new Map(),
    order: [],
    op: new Map(),
    tag: new Map(),
    guide: new Map(),
    webhook: new Map(),
    model: new Map(),
    webhooks: null,
    models: null,
    authentication: model.schemes.length ? { page: "", anchor: "authentication" } : null,
    overview: { page: "", anchor: "" },
    legacy: new Map(),
  };
  const single = mode === "single";
  add({ path: "", kind: single ? "single" : "overview", title: o.labels.overview, area: "reference", summary: undefined });

  for (const group of guideGroups(guides, o.labels.guides))
    for (const g of group.guides) {
      const target = single ? { page: "", anchor: `guides/${g.slug}` } : { page: `/guides/${g.slug}`, anchor: "" };
      site.guide.set(g.slug, target);
      if (!single) add({ path: target.page, kind: "guide", title: g.title, section: group.title, area: "guides", guide: g });
    }

  const taken = new Set<string>();
  for (const group of model.groups)
    for (const tag of group.tags) {
      let key = tag.id.replace(/^\//, "") || slug(tag.name);
      while ((!ref && RESERVED.has(key)) || taken.has(key)) key += "-";
      taken.add(key);
      const section = group.name ?? o.labels.api;
      const tagPath = `${ref}/${key}`;
      const tagTarget = single ? { page: "", anchor: key } : { page: tagPath, anchor: "" };
      site.tag.set(tag, tagTarget);
      if (!single) add({ path: tagPath, kind: "tag", title: tag.title, section, area: "reference", summary: tag.description?.split("\n")[0], tag });
      const used = new Set<string>();
      for (const op of tag.ops) {
        let s = opSlug(op.operationId);
        for (let n = 2; used.has(s); n++) s = `${opSlug(op.operationId)}-${n}`;
        used.add(s);
        const target = single ? { page: "", anchor: `${key}/${s}` } : mode === "tag" ? { page: tagPath, anchor: s } : { page: `${tagPath}/${s}`, anchor: "" };
        site.op.set(op, target);
        if (mode === "operation") add({ path: target.page, kind: "operation", title: op.op.summary ?? op.operationId, section: tag.title, area: "reference", summary: `${op.method.toUpperCase()} ${op.path}`, op, tag });
        site.legacy.set(op.id, target);
      }
      site.legacy.set(tag.id, tagTarget);
    }

  if (model.webhooks.length && !o.hide?.webhooks) {
    site.webhooks = single ? { page: "", anchor: "webhooks" } : { page: "/webhooks", anchor: "" };
    if (!single) add({ path: "/webhooks", kind: "webhooks", title: o.labels.webhooks, area: "reference", summary: undefined });
    for (const w of model.webhooks) {
      const target = { page: site.webhooks.page, anchor: `${single ? "webhooks/" : ""}${slug(w.name)}` };
      site.webhook.set(w, target);
      site.legacy.set(w.id, target);
    }
    site.legacy.set("/webhooks", site.webhooks);
  }
  if (model.models.length && !o.hide?.models) {
    site.models = single ? { page: "", anchor: "models" } : { page: "/models", anchor: "" };
    if (!single) add({ path: "/models", kind: "models", title: o.labels.models, area: "reference", summary: undefined });
    for (const m of model.models) {
      const target = { page: site.models.page, anchor: `${single ? "models/" : ""}${slug(m.name)}` };
      site.model.set(m, target);
      site.legacy.set(m.id, target);
    }
    site.legacy.set("/models", site.models);
  }

  site.legacy.set("/introduction", site.overview);
  if (site.authentication) site.legacy.set("/authentication", site.authentication);
  for (const [s, target] of site.guide) site.legacy.set(`/g/${s}`, target);
  for (const p of pages) site.byPath.set(p.path, p);
  // Reading order: the overview, the guides, then the reference.
  site.order = [...pages.filter((p) => p.area === "reference" && p.kind === "overview"), ...pages.filter((p) => p.area === "guides"), ...pages.filter((p) => p.area === "reference" && p.kind !== "overview")];
  return site;
}

/** A target's address below the docs' path, as a link: `/products/create-product`, `/products#create-product`, `#products/create-product`. */
export const hrefOf = (publicBase: string, t: Target) => `${publicBase}${t.page}${t.anchor ? `#${encodeURIComponent(t.anchor).replace(/%2F/g, "/")}` : ""}`;

/** The page path of an address the browser is at, or null when it isn't one of the site's. */
export function pageOf(site: Site, publicBase: string, pathname: string): DocPage | null {
  if (pathname !== publicBase && !pathname.startsWith(`${publicBase}/`)) return null;
  const rest = pathname.slice(publicBase.length).replace(/\/+$/, "");
  return site.byPath.get(rest) ?? null;
}

/** The pages before and after one, in reading order (within its tab when the page has tabs). */
export function neighbours(site: Site, page: DocPage, withinArea: boolean): { previous?: DocPage; next?: DocPage } {
  const list = withinArea ? site.order.filter((p) => p.area === page.area) : site.order;
  const i = list.indexOf(page);
  return i < 0 ? {} : { previous: list[i - 1], next: list[i + 1] };
}
