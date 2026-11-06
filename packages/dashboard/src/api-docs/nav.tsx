// The left navigation and the search over everything the page holds. Links are the site's addresses (site.ts): a page of its own, or an
// anchor on one, so they work the same with JavaScript off and when opened in a new tab.
import { useState } from "react";
import type { Guide } from "./context";
import { plainText } from "./markdown";
import type { Arranged } from "./openapi";
import { guideGroups, hrefOf, type DocPage, type Site, type Target } from "./site";
import type { Translate } from "./strings";

export { guideGroups };

export interface NavItem {
  key: string;
  label: string;
  target: Target;
  area: DocPage["area"];
  method?: string;
  internal?: boolean;
  children?: NavItem[];
}
export interface NavGroup {
  title?: string;
  area: DocPage["area"];
  items: NavItem[];
}

export interface Hidden {
  models?: boolean;
  webhooks?: boolean;
}

export function buildNav(site: Site, model: Arranged, guides: Guide[], hide: Hidden, t: Translate): NavGroup[] {
  const nav: NavGroup[] = [];
  const top: NavItem[] = [{ key: "overview", label: t("overview"), target: site.overview, area: "reference" }];
  if (site.authentication) top.push({ key: "authentication", label: t("authentication"), target: site.authentication, area: "reference" });
  nav.push({ area: "reference", items: top });
  for (const g of guideGroups(guides, t("guides")))
    nav.push({ title: g.title, area: "guides", items: g.guides.map((x) => ({ key: `g:${x.slug}`, label: x.title, target: site.guide.get(x.slug)!, area: "guides" as const })) });
  for (const g of model.groups)
    nav.push({
      title: g.name ?? t("api"),
      area: "reference",
      items: g.tags.map((s) => ({
        key: `t:${s.id}`,
        label: s.title,
        target: site.tag.get(s)!,
        area: "reference" as const,
        children: s.ops.map((o) => ({ key: `o:${o.id}`, label: o.op.summary ?? o.operationId, target: site.op.get(o)!, area: "reference" as const, method: o.method, internal: o.internal })),
      })),
    });
  const extra: NavItem[] = [];
  if (site.webhooks && !hide.webhooks)
    extra.push({ key: "webhooks", label: t("webhooks"), target: site.webhooks, area: "reference", children: model.webhooks.map((w) => ({ key: `w:${w.id}`, label: w.name, target: site.webhook.get(w)!, area: "reference" as const })) });
  if (site.models && !hide.models)
    extra.push({ key: "models", label: t("models"), target: site.models, area: "reference", children: model.models.map((m) => ({ key: `m:${m.id}`, label: m.name, target: site.model.get(m)!, area: "reference" as const })) });
  if (extra.length) nav.push({ area: "reference", items: extra });
  return nav;
}

export interface SearchItem {
  key: string;
  target: Target;
  kind: "operation" | "guide" | "webhook" | "model" | "section";
  title: string;
  sub: string;
  method?: string;
  /** Lowercase text the query is looked for in. */
  hay: string;
  titleHay: string;
}

const item = (key: string, target: Target, kind: SearchItem["kind"], title: string, sub: string, text: string, method?: string): SearchItem => ({
  key,
  target,
  kind,
  title,
  sub,
  method,
  hay: `${sub} ${text}`.toLowerCase(),
  titleHay: title.toLowerCase(),
});

export function buildIndex(site: Site, model: Arranged, guides: Guide[], hide: Hidden, t: Translate): SearchItem[] {
  const out: SearchItem[] = [];
  for (const g of guides) out.push(item(`g:${g.slug}`, site.guide.get(g.slug)!, "guide", g.title, g.group ?? t("guides"), g.text ?? ""));
  for (const s of model.tags) out.push(item(`t:${s.id}`, site.tag.get(s)!, "section", s.title, t("section"), plainText(s.description ?? "")));
  for (const o of model.ops) out.push(item(`o:${o.id}`, site.op.get(o)!, "operation", o.op.summary ?? o.operationId, `${o.method.toUpperCase()} ${o.path}`, `${o.operationId} ${o.tag} ${plainText(o.op.description ?? "")}`, o.method));
  if (!hide.webhooks) for (const w of model.webhooks) if (site.webhook.get(w)) out.push(item(`w:${w.id}`, site.webhook.get(w)!, "webhook", w.name, t("webhooks"), `${w.op.summary ?? ""} ${plainText(w.op.description ?? "")}`));
  if (!hide.models) for (const m of model.models) if (site.model.get(m)) out.push(item(`m:${m.id}`, site.model.get(m)!, "model", m.name, t("models"), plainText(m.schema.description ?? "")));
  return out;
}

/** Items that contain every word of the query, the better matches (the title, then the start of the title) first. */
export function search(index: SearchItem[], query: string, limit = 40): SearchItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: [number, SearchItem][] = [];
  for (const it of index) {
    let score = 0;
    let all = true;
    for (const w of words) {
      if (it.titleHay.startsWith(w)) score += 6;
      else if (it.titleHay.includes(w)) score += 4;
      else if (it.hay.includes(w)) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) scored.push([score, it]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, it]) => it);
}

export function Method({ method }: { method: string }) {
  return (
    <span className={`fd-method fd-m-${method}`} data-part="method" data-method={method}>
      {method === "delete" ? "DEL" : method.toUpperCase()}
    </span>
  );
}

/** Where the visitor is: the page and, on a page with several sections, the one in view. */
export interface Here {
  page: string;
  anchor: string | null;
}
const isAt = (t: Target, here: Here) => t.page === here.page && (t.anchor ? t.anchor === here.anchor : !here.anchor || here.anchor === "");
/** An item is open when the visitor is on it or on one of its children. */
const isWithin = (it: NavItem, here: Here): boolean =>
  isAt(it.target, here) ||
  (it.target.anchor === "" ? it.target.page === here.page : !!here.anchor && it.target.page === here.page && (here.anchor === it.target.anchor || here.anchor.startsWith(`${it.target.anchor}/`))) ||
  !!it.children?.some((c) => isAt(c.target, here) || (c.target.anchor === "" && c.target.page === here.page));

export function Nav({
  groups,
  here,
  publicBase,
  t,
  onNavigate,
  collapsible,
  upper,
}: {
  groups: NavGroup[];
  here: Here;
  publicBase: string;
  t: Translate;
  onNavigate: () => void;
  collapsible: boolean;
  upper: boolean;
}) {
  const [closed, setClosed] = useState<Set<number>>(() => new Set());
  const toggle = (i: number) => setClosed((c) => (c.has(i) ? new Set([...c].filter((x) => x !== i)) : new Set([...c, i])));
  return (
    <nav className="fd-nav" aria-label={t("navigation")} data-part="nav" data-case={upper ? "upper" : "sentence"}>
      {groups.map((g, gi) => {
        const folded = collapsible && closed.has(gi);
        const listId = `fd-nav-group-${gi}`;
        return (
          <div className="fd-nav-group" key={gi} data-part="nav-group">
            {g.title &&
              (collapsible ? (
                <h2 className="fd-nav-title">
                  <button type="button" className="fd-nav-fold" aria-expanded={!folded} aria-controls={listId} onClick={() => toggle(gi)} title={t("toggleGroup", { name: g.title })}>
                    <span>{g.title}</span>
                    <svg className="fd-icon" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </h2>
              ) : (
                <h2 className="fd-nav-title">{g.title}</h2>
              ))}
            <ul id={listId} hidden={folded}>
              {g.items.map((it) => {
                const here_ = isAt(it.target, here);
                const within = isWithin(it, here);
                return (
                  <li key={it.key}>
                    <a href={hrefOf(publicBase, it.target)} aria-current={here_ ? "page" : undefined} data-within={within || undefined} onClick={onNavigate} data-part="nav-item">
                      {it.label}
                    </a>
                    {within && it.children && it.children.length > 0 && (
                      <ul className="fd-nav-children">
                        {it.children.map((c) => (
                          <li key={c.key}>
                            <a href={hrefOf(publicBase, c.target)} aria-current={isAt(c.target, here) ? "page" : undefined} onClick={onNavigate} title={c.label} data-part="nav-item">
                              {c.method && <Method method={c.method} />}
                              <span>{c.label}</span>
                              {c.internal && <span className="fd-flag fd-flag-internal">{t("internal")}</span>}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function SearchResults({ results, query, publicBase, t, onNavigate }: { results: SearchItem[]; query: string; publicBase: string; t: Translate; onNavigate: () => void }) {
  return (
    <div className="fd-results" aria-label={t("searchResults")} role="region" data-part="search-results">
      <p className="fd-note" role="status">
        {results.length === 1 ? t("resultsOne") : results.length ? t("resultsCount", { n: results.length }) : t("searchNone", { q: query })}
      </p>
      <ul>
        {results.map((r) => (
          <li key={r.key}>
            <a href={hrefOf(publicBase, r.target)} onClick={onNavigate}>
              {r.method && <Method method={r.method} />}
              <span className="fd-result-title">{r.title}</span>
              <span className="fd-result-sub">{r.sub}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
