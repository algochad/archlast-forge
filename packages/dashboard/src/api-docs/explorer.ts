// Loading the request builder ("Try it") and giving it what it needs from the page. The builder is a separate script, fetched the first time
// it is wanted (and prefetched when the visitor hovers or focuses the button), so the page's own first load stays small.
import type { ExplorerOptions, ForgeExplorerGlobal } from "./contract";

const loading = new Map<string, Promise<ForgeExplorerGlobal>>();

export function loadExplorer(url: string): Promise<ForgeExplorerGlobal> {
  if (window.ForgeExplorer) return Promise.resolve(window.ForgeExplorer);
  let p = loading.get(url);
  if (!p) {
    p = new Promise<ForgeExplorerGlobal>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => (window.ForgeExplorer ? resolve(window.ForgeExplorer) : reject(new Error("The request builder loaded but did not define ForgeExplorer")));
      script.onerror = () => reject(new Error(`The request builder didn't load (${url})`));
      document.head.append(script);
    });
    p.catch(() => loading.delete(url)); // a later press tries again
    loading.set(url, p);
  }
  return p;
}

const prefetched = new Set<string>();
export function prefetchExplorer(url: string) {
  if (prefetched.has(url) || loading.has(url) || window.ForgeExplorer) return;
  prefetched.add(url);
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "script";
  link.href = url;
  document.head.append(link);
}

const COLORS = { background: "--fd-bg", surface: "--fd-soft", text: "--fd-text", muted: "--fd-muted", border: "--fd-border", accent: "--fd-accent" } as const;

/** The page's colours as they are now: custom properties don't resolve `light-dark()`, so each is read through a property that does. */
export function resolveTheme(root: HTMLElement, mode: "light" | "dark"): ExplorerOptions["theme"] {
  const probe = document.createElement("span");
  probe.style.display = "none";
  root.append(probe);
  const color = (token: string) => {
    probe.style.color = "";
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const style = getComputedStyle(root);
  const out = { mode, ...Object.fromEntries(Object.entries(COLORS).map(([k, token]) => [k, color(token)])), font: style.getPropertyValue("--fd-sans").trim(), monoFont: style.getPropertyValue("--fd-mono").trim(), radius: style.getPropertyValue("--fd-r").trim() };
  probe.remove();
  return out as ExplorerOptions["theme"];
}
