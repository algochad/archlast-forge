// Navigation for pages with islands, in the browser, with no framework: a click on a link to another page of the site fetches that page's HTML and swaps it in
// (the head's differences and the body), so the document, its stylesheets and the islands' shared client survive. What a navigation shows is what loading the URL would
// show; the only things that carry over are the document itself and the JavaScript already loaded. A target that is not a page with islands (the server says so with
// `x-forge-page: islands`) is loaded the ordinary way, and so is anything this does not understand.
//
// The pieces of the page this leaves to others: islands.tsx puts `window.__forgeIslands = { mount, unmount }` there, and a page's state is a JSON block (#forge-state).

interface Islands {
  mount(): void;
  unmount(): void;
}
export {};
declare global {
  interface Window {
    __forgeIslands?: Islands;
    /** Moves to `href` as a click on a link would. Islands use it for `useNavigate()`. */
    __forgeNavigate?: (href: string, o?: { replace?: boolean }) => void;
  }
}

const PAGE = "islands";
/** Scripts already in the document, by path: a module is loaded once, and a page that wants it again keeps the copy there. */
const loaded = new Set<string>();
for (const s of document.querySelectorAll<HTMLScriptElement>("script[src]")) loaded.add(new URL(s.src, location.href).pathname);
let current = 0;
/** The page on show, without its hash: a move that only changes the hash does not fetch anything. */
let shown = location.pathname + location.search;

const sameOrigin = (url: URL) => url.origin === location.origin;
const samePageHash = (url: URL) => url.pathname === location.pathname && url.search === location.search && url.hash !== "";

/** Head elements by what they say; scripts are the page's behavior and are handled apart. */
function syncHead(next: HTMLHeadElement) {
  const key = (el: Element) => el.outerHTML;
  const have = new Map<string, Element>();
  for (const el of document.head.children) if (el.tagName !== "SCRIPT" && !el.hasAttribute("data-forge-keep")) have.set(key(el), el);
  const want = new Set<string>();
  for (const el of next.children) {
    if (el.tagName === "SCRIPT") continue;
    want.add(key(el));
    if (!have.has(key(el))) document.head.appendChild(document.importNode(el, true));
  }
  for (const [k, el] of have) if (!want.has(k)) el.remove();
}

function syncAttributes(from: Element, to: Element) {
  for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
  for (const a of [...from.attributes]) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
}

async function show(url: URL, how: "push" | "replace" | "pop", scroll?: number): Promise<void> {
  const mine = ++current;
  shown = url.pathname + url.search;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "text/html" }, credentials: "same-origin" });
  } catch {
    return void location.assign(url.href);
  }
  const final = new URL(res.url);
  if (!sameOrigin(final) || !(res.headers.get("content-type") ?? "").includes("text/html") || res.headers.get("x-forge-page") !== PAGE) return void location.assign(url.href);
  const html = await res.text();
  if (mine !== current) return; // another navigation began meanwhile; it decides
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body) return void location.assign(url.href);

  if (how !== "pop") history.replaceState({ ...(history.state ?? {}), y: scrollY }, "");
  window.__forgeIslands?.unmount();
  document.title = doc.title;
  syncHead(doc.head);
  syncAttributes(doc.body, document.body);
  document.body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  if (how === "push") history.pushState({}, "", final);
  else if (how === "replace") history.replaceState({}, "", final);

  // Scripts do not run when parsed into a document, so each module the new page names that is not loaded yet is added. The state is a JSON block and needs none.
  for (const s of doc.querySelectorAll<HTMLScriptElement>('script[src][type="module"]')) {
    const path = new URL(s.src, final).pathname;
    if (loaded.has(path)) continue;
    loaded.add(path);
    const el = document.createElement("script");
    el.type = "module";
    el.src = path;
    el.async = true;
    document.head.appendChild(el);
  }
  window.__forgeIslands?.mount();

  if (how === "pop") scrollTo(0, scroll ?? 0);
  else if (final.hash && document.getElementById(decodeURIComponent(final.hash.slice(1)))) document.getElementById(decodeURIComponent(final.hash.slice(1)))!.scrollIntoView();
  else scrollTo(0, 0);
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/** Moves to `href`: a page of this site as a click on a link would, anything else by loading it. */
function navigate(href: string, o: { replace?: boolean } = {}) {
  const url = new URL(href, location.href);
  if (!sameOrigin(url)) return void location.assign(url.href);
  if (samePageHash(url)) {
    o.replace ? history.replaceState({}, "", url) : history.pushState({}, "", url);
    return void document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
  }
  void show(url, o.replace ? "replace" : "push");
}
window.__forgeNavigate = navigate;

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a || !a.href || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.closest("[data-forge-reload]")) return;
  const url = new URL(a.href, location.href);
  if (!/^https?:$/.test(url.protocol) || !sameOrigin(url)) return;
  e.preventDefault();
  navigate(a.href);
});

addEventListener("popstate", (e: PopStateEvent) => {
  const url = new URL(location.href);
  if (url.pathname + url.search === shown) return void document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
  void show(url, "pop", (e.state as { y?: number } | null)?.y);
});
history.scrollRestoration = "manual";
