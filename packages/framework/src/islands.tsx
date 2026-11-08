// The browser side of islands: find the markers island.tsx left in the page and hydrate each on its own root. They share the page's client, query cache,
// viewer and clock, so two islands show the same live data. There is no router in the browser: a move from inside an island goes through nav.ts.
import { ArchlastForgeClient } from "@archlast/forge-client";
import { hydrate, QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { createPath, Router, type To } from "react-router";
import { createViewerStore, type Viewer } from "./context";
import { reportRecoverableError } from "./hydration";
import type { PageState } from "./state";
import { Providers } from "./providers";

export type IslandRegistry = Record<string, () => Promise<ComponentType<any>>>;

const toViewer = (user: { id: string; email: string; name: string } | null | undefined): Viewer | null => (user ? { userId: user.id, email: user.email, name: user.name } : null);

const hrefOf = (to: To) => (typeof to === "string" ? to : createPath(to));

/** What `useNavigate()` and `<Link>` inside an island use: a move to another page, as a click on a link would do it (see nav.ts), or a load of the page. */
const navigator = {
  createHref: hrefOf,
  encodeLocation: (to: To) => {
    const url = new URL(hrefOf(to), "http://x");
    return { pathname: url.pathname, search: url.search, hash: url.hash };
  },
  go: (n: number) => history.go(n),
  push: (to: To) => (window.__forgeNavigate ? window.__forgeNavigate(hrefOf(to)) : location.assign(hrefOf(to))),
  replace: (to: To) => (window.__forgeNavigate ? window.__forgeNavigate(hrefOf(to), { replace: true }) : location.replace(hrefOf(to))),
};

/** The page's state: a JSON block, which a page that was swapped in carries just as one that was loaded does (an inline script would need the page's nonce). */
function readState(): PageState | undefined {
  const el = document.getElementById("forge-state");
  if (!el?.textContent) return undefined;
  return JSON.parse(el.textContent) as PageState;
}

/** Runs in the browser (the generated islands entry calls it): the page's islands now, and again for each page that is swapped in. */
export function startIslands(registry: IslandRegistry, authPlugins?: unknown[]) {
  const client = new ArchlastForgeClient({ authPlugins });
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const viewer = createViewerStore(null);
  client.onSessionChange((user) => viewer.set(toViewer(user)));
  let roots: Root[] = [];

  const mount = () => {
    const state = readState();
    const markers = [...document.querySelectorAll<HTMLElement>("[data-forge-island]:not([data-forge-mounted])")];
    if (!state || markers.length === 0) return;
    hydrate(queryClient, state.queries);
    viewer.set(state.viewer);
    const time = { now: state.now ?? Date.now(), timeZone: state.timeZone ?? "UTC" };
    const here = { pathname: location.pathname, search: location.search, hash: location.hash };
    for (const el of markers) {
      el.setAttribute("data-forge-mounted", "");
      const id = el.dataset.forgeIsland!;
      const load = registry[id];
      if (!load) {
        console.error(`[archlast-forge] the page has an island "${id}" that this build doesn't know. Reload the page.`);
        continue;
      }
      void load().then((Component) => {
        const props = JSON.parse(el.dataset.props ?? "{}");
        roots.push(
          hydrateRoot(
            el,
            <Providers client={client} queryClient={queryClient} viewer={viewer} dev={state.dev} time={time} nonce={state.nonce}>
              <Router location={here} navigator={navigator}>
                <Component {...props} />
              </Router>
            </Providers>,
            { onRecoverableError: (error) => reportRecoverableError(error, window.__forgeNotice) },
          ),
        );
      });
    }
  };
  const unmount = () => {
    // After the DOM has been replaced there is nothing to render into; React releases the roots' state.
    const old = roots;
    roots = [];
    queueMicrotask(() => old.forEach((r) => r.unmount()));
  };
  window.__forgeIslands = { mount, unmount };
  mount();
}
