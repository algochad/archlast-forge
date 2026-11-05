// The left navigation and the search over everything the page holds.
import type { Guide } from "./context";
import { plainText } from "./markdown";
import type { Arranged } from "./openapi";
import type { Translate } from "./strings";

export interface NavItem {
  id: string;
  label: string;
  method?: string;
  internal?: boolean;
  children?: NavItem[];
}
export interface NavGroup {
  title?: string;
  items: NavItem[];
}

export interface Hidden {
  models?: boolean;
  webhooks?: boolean;
}

/** Guides in their order, grouped by their `group` in order of first appearance; those with none are under "Guides". */
export function guideGroups(guides: Guide[], fallback: string): { title: string; guides: Guide[] }[] {
  const sorted = guides.map((g, i) => [g, i] as const).sort(([a, i], [b, j]) => (a.order ?? Infinity) - (b.order ?? Infinity) || i - j).map(([g]) => g);
  const out = new Map<string, Guide[]>();
  for (const g of sorted) out.set(g.group ?? fallback, [...(out.get(g.group ?? fallback) ?? []), g]);
  return [...out].map(([title, list]) => ({ title, guides: list }));
}

export function buildNav(model: Arranged, guides: Guide[], hide: Hidden, t: Translate): NavGroup[] {
  const nav: NavGroup[] = [];
  nav.push({ items: [{ id: "/introduction", label: t("overview") }] });
  for (const g of guideGroups(guides, t("guides"))) nav.push({ title: g.title, items: g.guides.map((x) => ({ id: `/g/${x.slug}`, label: x.title })) });
  if (model.schemes.length) nav.push({ items: [{ id: "/authentication", label: t("authentication") }] });
  for (const g of model.groups)
    nav.push({
      title: g.name ?? t("api"),
      items: g.tags.map((s) => ({ id: s.id, label: s.title, children: s.ops.map((o) => ({ id: o.id, label: o.op.summary ?? o.operationId, method: o.method, internal: o.internal })) })),
    });
  const extra: NavItem[] = [];
  if (model.webhooks.length && !hide.webhooks) extra.push({ id: "/webhooks", label: t("webhooks"), children: model.webhooks.map((w) => ({ id: w.id, label: w.name })) });
  if (model.models.length && !hide.models) extra.push({ id: "/models", label: t("models"), children: model.models.map((m) => ({ id: m.id, label: m.name })) });
  if (extra.length) nav.push({ items: extra });
  return nav;
}

export interface SearchItem {
  id: string;
  kind: "operation" | "guide" | "webhook" | "model" | "section";
  title: string;
  sub: string;
  method?: string;
  /** Lowercase text the query is looked for in. */
  hay: string;
  titleHay: string;
}

const item = (id: string, kind: SearchItem["kind"], title: string, sub: string, text: string, method?: string): SearchItem => ({ id, kind, title, sub, method, hay: `${sub} ${text}`.toLowerCase(), titleHay: title.toLowerCase() });

export function buildIndex(model: Arranged, guides: Guide[], hide: Hidden, t: Translate): SearchItem[] {
  const out: SearchItem[] = [];
  for (const g of guides) out.push(item(`/g/${g.slug}`, "guide", g.title, g.group ?? t("guides"), g.text ?? ""));
  for (const s of model.tags) out.push(item(s.id, "section", s.title, t("section"), plainText(s.description ?? "")));
  for (const o of model.ops) out.push(item(o.id, "operation", o.op.summary ?? o.operationId, `${o.method.toUpperCase()} ${o.path}`, `${o.operationId} ${o.tag} ${plainText(o.op.description ?? "")}`, o.method));
  if (!hide.webhooks) for (const w of model.webhooks) out.push(item(w.id, "webhook", w.name, t("webhooks"), `${w.op.summary ?? ""} ${plainText(w.op.description ?? "")}`));
  if (!hide.models) for (const m of model.models) out.push(item(m.id, "model", m.name, t("models"), plainText(m.schema.description ?? "")));
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

function Method({ method }: { method: string }) {
  return <span className={`fd-method fd-m-${method}`}>{method === "delete" ? "DEL" : method.toUpperCase()}</span>;
}

export function Nav({ groups, active, t, onNavigate }: { groups: NavGroup[]; active: string | null; t: Translate; onNavigate: () => void }) {
  return (
    <nav className="fd-nav" aria-label={t("navigation")}>
      {groups.map((g, gi) => (
        <div className="fd-nav-group" key={gi}>
          {g.title && <h2 className="fd-nav-title">{g.title}</h2>}
          <ul>
            {g.items.map((it) => {
              const here = active === it.id;
              const within = !!active && (here || active.startsWith(`${it.id}/`));
              return (
                <li key={it.id}>
                  <a href={`#${it.id}`} aria-current={here ? "location" : undefined} data-within={within || undefined} onClick={onNavigate}>
                    {it.label}
                  </a>
                  {within && it.children && (
                    <ul className="fd-nav-children">
                      {it.children.map((c) => (
                        <li key={c.id}>
                          <a href={`#${c.id}`} aria-current={active === c.id ? "location" : undefined} onClick={onNavigate} title={c.label}>
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
      ))}
    </nav>
  );
}

export function SearchResults({ results, query, t, onNavigate }: { results: SearchItem[]; query: string; t: Translate; onNavigate: () => void }) {
  return (
    <div className="fd-results" aria-label={t("searchResults")} role="region">
      <p className="fd-note" role="status">
        {results.length === 1 ? t("resultsOne") : results.length ? t("resultsCount", { n: results.length }) : t("searchNone", { q: query })}
      </p>
      <ul>
        {results.map((r) => (
          <li key={r.id}>
            <a href={`#${r.id}`} onClick={onNavigate}>
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
