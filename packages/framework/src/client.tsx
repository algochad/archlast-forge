import { ArchlastForgeClient, queryKey } from "@archlast/forge-client";
import { getFunctionName } from "@archlast/forge-runtime";
import { hydrate, QueryClient } from "@tanstack/react-query";
import { hydrateRoot } from "react-dom/client";
import { createBrowserRouter, matchRoutes, RouterContextProvider } from "react-router";
import { RouterProvider } from "react-router/dom";
import { createViewerStore, forgeContext, type LoaderContext, type Viewer, type ViewerStore } from "./context";
import { reportRecoverableError } from "./hydration";
import { Providers } from "./providers";
import { toRouteObjects, type ManifestNode } from "./route-objects";
import { reviveErrors } from "./state";

export type { ManifestNode, RouteModule } from "./route-objects";

const toViewer = (user: { id: string; email: string; name: string } | null | undefined): Viewer | null => (user ? { userId: user.id, email: user.email, name: user.name } : null);

function loaderContext(client: ArchlastForgeClient, queryClient: QueryClient, viewer: ViewerStore): LoaderContext {
  let asking: Promise<Viewer | null> | undefined;
  return {
    async query(ref, ...args) {
      const value = await client.query(ref, ...args);
      queryClient.setQueryData(queryKey(ref, args[0]), value);
      return value;
    },
    // Navigations ask the server: the answer must be right the moment after a sign-in, before the session store has caught up.
    viewer: () =>
      (asking ??= client.auth
        .getSession({ query: { disableCookieCache: true } })
        .then((res) => {
          const v = toViewer(res.data?.user);
          viewer.set(v);
          return v;
        })
        .finally(() => void (asking = undefined))),
  };
}

/** Runs in the browser (the generated entry calls it): hydrates the server-rendered page and takes over navigation. */
export async function startClient(manifest: ManifestNode) {
  const state = window.__FORGE__;
  if (!state) throw new Error("This page wasn't rendered by archlast-forge: window.__FORGE__ is missing.");
  const client = new ArchlastForgeClient({ authPlugins: manifest.module?.authPlugins }); // app/root.tsx's, if it exports them
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  hydrate(queryClient, state.queries);
  const viewer = createViewerStore(state.viewer);
  client.onSessionChange((user) => viewer.set(toViewer(user)));
  const ctx = loaderContext(client, queryClient, viewer);

  const routes = toRouteObjects(manifest);
  // The routes of this page must be loaded before the router starts; otherwise it has nothing to hydrate.
  for (const m of matchRoutes(routes, window.location) ?? []) {
    if (m.route.lazy) Object.assign(m.route, { ...(await (m.route.lazy as () => Promise<object>)()), lazy: undefined });
  }
  const router = createBrowserRouter(routes, {
    hydrationData: { loaderData: state.hydration.loaderData, actionData: state.hydration.actionData, errors: reviveErrors(state.hydration.errors) },
    getContext: () => new RouterContextProvider(new Map([[forgeContext, ctx]])),
  });
  // The server's instant and zone, so this first render says what the server's HTML says; the hooks move to the browser's own right after.
  const time = { now: state.now ?? Date.now(), timeZone: state.timeZone ?? "UTC" };
  hydrateRoot(
    document,
    <Providers client={client} queryClient={queryClient} viewer={viewer} dev={state.dev} time={time} nonce={state.nonce}>
      <RouterProvider router={router} />
    </Providers>,
    { onRecoverableError: (error) => reportRecoverableError(error, window.__forgeNotice) },
  );
}
