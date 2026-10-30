import { type ComponentProps, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useOutletContext, useParams } from "react-router";
import { Code } from "./Code";
import type { Doc } from "./doc";
import { Arrow } from "./icons";
import { GITHUB, GROUPS, PAGES, type Slug, groupOf, isSlug, reading, titleOf } from "./nav";

const heading = (Tag: "h1" | "h2" | "h3") => ({ id, children }: ComponentProps<"h2">) => (
  <Tag id={id}>
    <a href={`#${id}`}>{children}</a>
  </Tag>
);

/** What MDX pages render with: `<Code>` is what the build turns fenced blocks into. Add a component here to use it in any page. */
export const components = {
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  a: ({ href = "", ...props }: ComponentProps<"a">) => (href.startsWith("/") ? <Link to={href} {...props} /> : <a href={href} {...props} />),
  table: (props: ComponentProps<"table">) => (
    <div className="table">
      <table {...props} />
    </div>
  ),
  Code,
};

/** Loads a page's chunk. The previous page stays up until the next one is ready, or `failed` says it will not come (a tab left open across a deploy asks for chunks that are gone). */
function useDoc(slug: string | undefined) {
  const [doc, setDoc] = useState<{ slug: Slug; mod: Doc }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!isSlug(slug)) return;
    let live = true;
    setFailed(false);
    PAGES[slug][1]().then((mod) => live && setDoc({ slug, mod }), (e) => (console.error(e), live && setFailed(true)));
    return () => void (live = false);
  }, [slug]);
  return { doc, failed };
}

/** The heading being read, for the outline. */
function useCurrentHeading(doc: unknown) {
  const [current, setCurrent] = useState<string>();
  useEffect(() => {
    const heads = [...document.querySelectorAll<HTMLElement>(".prose h2[id], .prose h3[id]")];
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
        setCurrent((heads.find((h) => visible.has(h.id)) ?? [...heads].reverse().find((h) => h.getBoundingClientRect().top < 100))?.id);
      },
      { rootMargin: "-70px 0px -65% 0px" },
    );
    heads.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [doc]);
  return current;
}

export function NotFound() {
  useEffect(() => void (document.title = "Page not found · archlast-forge"), []);
  return (
    <main id="content" className="doc">
      <article className="prose">
        <h1>Page not found</h1>
        <p>
          <Link to="/">Back to the home page</Link>
        </p>
      </article>
    </main>
  );
}

export function DocPage() {
  const { slug: wanted } = useParams();
  const closeMenu = useOutletContext<() => void>();
  const { hash } = useLocation();
  const { doc, failed } = useDoc(wanted);
  const current = useCurrentHeading(doc);
  const side = useRef<HTMLElement>(null);

  // Keep the current page in view in a long sidebar.
  useEffect(() => {
    const el = side.current;
    const here = el?.querySelector<HTMLElement>("[aria-current]");
    if (el && here) el.scrollTop = Math.max(0, here.offsetTop - el.clientHeight / 3);
  }, []);

  // A new page starts at the top, or at its anchor. The router leaves both to us because the content loads late.
  useEffect(() => {
    if (!doc) return;
    document.title = `${titleOf(doc.slug)} · archlast-forge`;
    const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    target ? target.scrollIntoView() : scrollTo(0, 0);
  }, [doc, hash]);

  if (!isSlug(wanted)) return <NotFound />;

  const Content = doc?.mod.default;
  const toc = doc?.mod.headings.filter((h) => h.depth > 1) ?? [];
  const at = doc ? reading.indexOf(doc.slug) : 0;
  const [prev, next] = [reading[at - 1], reading[at + 1]];
  return (
    <>
      <div className="scrim" onClick={closeMenu} />
      <div className="shell">
        <aside className="side" id="sidebar" aria-label="Docs" ref={side}>
          {GROUPS.map(([name, slugs]) => (
            <div className="group" key={name}>
              <div className="group-name">{name}</div>
              {slugs.map((s) => (
                <NavLink key={s} to={`/${s}`}>
                  {titleOf(s)}
                </NavLink>
              ))}
            </div>
          ))}
        </aside>
        <main id="content" className="doc">
          {failed && (
            <article className="prose">
              <p>
                This page could not be loaded. <a href={`/${wanted}`}>Reload it</a>.
              </p>
            </article>
          )}
          {!failed && doc && Content && (
            <article>
              <div className="crumbs">
                <Link to="/">Home</Link>
                <span>/</span>
                <span>{groupOf(doc.slug)}</span>
                <span>/</span>
                <span aria-current="page">{titleOf(doc.slug)}</span>
              </div>
              <div className="prose">
                <Content components={components} />
              </div>
              <div className="edit">
                <a href={`${GITHUB}/edit/master/apps/docs/content/${doc.slug}.mdx`} rel="noopener">
                  Edit this page on GitHub <Arrow />
                </a>
              </div>
              <nav className="pager" aria-label="Pages">
                {prev ? (
                  <Link className="prev" to={`/${prev}`}>
                    <small>Previous</small>
                    <span>{titleOf(prev)}</span>
                  </Link>
                ) : (
                  <span />
                )}
                {next ? (
                  <Link className="next" to={`/${next}`}>
                    <small>Next</small>
                    <span>{titleOf(next)}</span>
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            </article>
          )}
        </main>
        {toc.length > 0 && (
          <aside className="toc" aria-label="On this page">
            <div className="toc-in">
              <div className="toc-title">On this page</div>
              {toc.map((h) => (
                <a key={h.id} href={`#${h.id}`} className={`l${h.depth}`} aria-current={h.id === current || undefined}>
                  {h.parts.map((p, i) => (typeof p === "string" ? p : <code key={i}>{p.code}</code>))}
                </a>
              ))}
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
