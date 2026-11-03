import { type ComponentProps, type Ref, useEffect, useRef, useState } from "react";
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

const loaded = new Map<Slug, Doc>();

/** Brings a page's chunk in before the first render, so the HTML the build put in the page is replaced without a blank frame. */
export const preload = (slug?: string) => (isSlug(slug) ? PAGES[slug][1]().then((mod) => void loaded.set(slug, mod)) : Promise.resolve());

/** Loads a page's chunk. The previous page stays up until the next one is ready, or `failed` says it will not come (a tab left open across a deploy asks for chunks that are gone). */
function useDoc(slug: string | undefined) {
  const [doc, setDoc] = useState<{ slug: Slug; mod: Doc } | undefined>(() => (isSlug(slug) && loaded.has(slug) ? { slug, mod: loaded.get(slug)! } : undefined));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!isSlug(slug)) return;
    let live = true;
    setFailed(false);
    PAGES[slug][1]().then((mod) => (loaded.set(slug, mod), live && setDoc({ slug, mod })), (e) => (console.error(e), live && setFailed(true)));
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

/** Copies a page's Markdown. The copy is made from the promise, which keeps Safari from dropping the click's permission while the file loads. */
function CopyPage({ slug }: { slug: Slug }) {
  const [state, setState] = useState<"copied" | "failed">();
  const copy = async () => {
    try {
      const text = fetch(`/${slug}.md`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))).then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState(undefined), 2000);
  };
  return (
    <button type="button" onClick={copy} aria-live="polite">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy page"}
    </button>
  );
}

export function Sidebar({ ref }: { ref?: Ref<HTMLElement> }) {
  return (
    <aside className="side" id="sidebar" aria-label="Docs" ref={ref}>
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
  );
}

/** A page's text with its crumbs and pager. The build renders it into each page's HTML too. */
export function Article({ slug, Content }: { slug: Slug; Content: Doc["default"] }) {
  const at = reading.indexOf(slug);
  const [prev, next] = [reading[at - 1], reading[at + 1]];
  return (
    <article>
      <div className="crumbs">
        <Link to="/">Home</Link>
        <span>/</span>
        <span>{groupOf(slug)}</span>
        <span>/</span>
        <span aria-current="page">{titleOf(slug)}</span>
        <span className="actions">
          <CopyPage slug={slug} />
          <a href={`/${slug}.md`}>View as Markdown</a>
        </span>
      </div>
      <div className="prose">
        <Content components={components} />
      </div>
      <div className="edit">
        <a href={`${GITHUB}/edit/staging/apps/docs/content/${slug}.mdx`} rel="noopener">
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
  return (
    <>
      <div className="scrim" onClick={closeMenu} />
      <div className="shell">
        <Sidebar ref={side} />
        <main id="content" className="doc">
          {failed && (
            <article className="prose">
              <p>
                This page could not be loaded. <a href={`/${wanted}`}>Reload it</a>.
              </p>
            </article>
          )}
          {!failed && doc && Content && <Article slug={doc.slug} Content={Content} />}
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
