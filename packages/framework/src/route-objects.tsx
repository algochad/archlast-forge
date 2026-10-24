import { Outlet, type LoaderFunctionArgs, type RouteObject, type ShouldRevalidateFunction } from "react-router";
import type { ComponentType, ReactNode } from "react";
import { forgeContext, type LoaderArgs } from "./context";
import { DefaultErrorBoundary, DefaultLayout } from "./default-root";

/** What a file in app/routes (or app/root.tsx) may export. */
export interface RouteModule {
  default?: ComponentType;
  loader?: (args: LoaderArgs) => unknown;
  ErrorBoundary?: ComponentType;
  handle?: unknown;
  shouldRevalidate?: ShouldRevalidateFunction;
  /** Root only: the `<html>` document that wraps the app and its error page. */
  Layout?: ComponentType<{ children: ReactNode }>;
}

/** A route in the generated manifest: its module is imported up front (server) or on demand (browser). */
export interface ManifestNode {
  id: string;
  path?: string;
  index?: boolean;
  module?: RouteModule;
  load?: () => Promise<RouteModule>;
  children?: ManifestNode[];
}

const wrapLoader =
  (loader: NonNullable<RouteModule["loader"]>) =>
  ({ request, params, context }: LoaderFunctionArgs) =>
    loader({ request, params, ctx: context.get(forgeContext) });

function propsOf(m: RouteModule, root: boolean): RouteObject {
  const out: Record<string, unknown> = {};
  if (root) {
    const Layout = m.Layout ?? DefaultLayout;
    const App = m.default;
    const Boundary = m.ErrorBoundary ?? DefaultErrorBoundary;
    out.Component = () => <Layout>{App ? <App /> : <Outlet />}</Layout>;
    // An error replaces the whole page, so it renders inside the document too.
    out.ErrorBoundary = () => (
      <Layout>
        <Boundary />
      </Layout>
    );
  } else {
    if (m.default) out.Component = m.default;
    if (m.ErrorBoundary) out.ErrorBoundary = m.ErrorBoundary;
  }
  if (m.loader) out.loader = wrapLoader(m.loader);
  if (m.handle !== undefined) out.handle = m.handle;
  if (m.shouldRevalidate) out.shouldRevalidate = m.shouldRevalidate;
  return out as RouteObject;
}

function convert(node: ManifestNode, root: boolean): RouteObject {
  const base = { id: node.id, ...(node.path !== undefined && { path: node.path }), ...(node.index && { index: true }) };
  const children = node.children?.map((c) => convert(c, false));
  const route = node.module
    ? { ...base, ...propsOf(node.module, root) }
    : { ...base, lazy: async () => propsOf(await node.load!(), root) };
  return (children?.length ? { ...route, children } : route) as RouteObject;
}

/** The root route is "/" with every file route below it. */
export const toRouteObjects = (root: ManifestNode): RouteObject[] => [convert({ ...root, path: "/" }, true)];
