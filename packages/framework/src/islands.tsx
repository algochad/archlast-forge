// The browser side of islands: find the markers island.tsx left in the page and hydrate each on its own root. They share the page's client, query cache,
// viewer and clock, so two islands show the same live data. Navigation from inside an island is a page load; there is no router here.
import { ArchlastForgeClient } from "@archlast/forge-client";
import { hydrate, QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { hydrateRoot } from "react-dom/client";
import { createPath, Router, type To } from "react-router";
import { createViewerStore, type Viewer } from "./context";
import { reportRecoverableError } from "./hydration";
import { Providers } from "./providers";

export type IslandRegistry = Record<string, () => Promise<ComponentType<any>>>;

const toViewer = (user: { id: string; email: string; name: string } | null | undefined): Viewer | null => (user ? { userId: user.id, email: user.email, name: user.name } : null);

const hrefOf = (to: To) => (typeof to === "string" ? to : createPath(to));

/** What `useNavigate()` and `<Link>` inside an island use: every move is a load of the page. */
const navigator = {
  createHref: hrefOf,
  encodeLocation: (to: To) => {
    const url = new URL(hrefOf(to), "http://x");
    return { pathname: url.pathname, search: url.search, hash: url.hash };
  },
  go: (n: number) => history.go(n),
  push: (to: To) => void location.assign(hrefOf(to)),
  replace: (to: To) => void location.replace(hrefOf(to)),
};

/** Runs in the browser (the generated islands entry calls it). */
export async function startIslands(registry: IslandRegistry, authPlugins?: unknown[]) {
  const state = window.__FORGE__;
  if (!state) throw new Error("This page wasn't rendered by archlast-forge: window.__FORGE__ is missing.");
  const client = new ArchlastForgeClient({ authPlugins });
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  hydrate(queryClient, state.queries);
  const viewer = createViewerStore(state.viewer);
  client.onSessionChange((user) => viewer.set(toViewer(user)));
  const time = { now: state.now ?? Date.now(), timeZone: state.timeZone ?? "UTC" };
  const here = { pathname: location.pathname, search: location.search, hash: location.hash };

  await Promise.all(
    [...document.querySelectorAll<HTMLElement>("[data-forge-island]")].map(async (el) => {
      const id = el.dataset.forgeIsland!;
      const load = registry[id];
      if (!load) return console.error(`[archlast-forge] the page has an island "${id}" that this build doesn't know. Reload the page.`);
      const Component = await load();
      const props = JSON.parse(el.dataset.props ?? "{}");
      hydrateRoot(
        el,
        <Providers client={client} queryClient={queryClient} viewer={viewer} dev={state.dev} time={time} nonce={state.nonce}>
          <Router location={here} navigator={navigator}>
            <Component {...props} />
          </Router>
        </Providers>,
        { onRecoverableError: (error) => reportRecoverableError(error, window.__forgeNotice) },
      );
    }),
  );
}
