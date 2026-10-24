import type { PublicQuery } from "@archlast/forge-client";
import type { FunctionReturn, OptionalArgs } from "@archlast/forge-runtime";
import { createContext as createRouterContext } from "react-router";

/** The signed-in user, as pages see them. */
export interface Viewer {
  userId: string;
  email: string;
  name: string;
}

/** What a route's `loader` can do. The same code runs on the server (first load) and in the browser (navigations). */
export interface LoaderContext {
  /**
   * Runs a public query as the signed-in user and keeps its result in the page's live cache, so `useQuery(ref, args)` in the
   * page has its data on first render and stays live afterwards.
   */
  query<R extends PublicQuery>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>>;
  /** The signed-in user, or null. In the browser this asks the server, so it is right even just after signing in or out. */
  viewer(): Promise<Viewer | null>;
}

/** Where the loader context travels through React Router: `args.context.get(forgeContext)`. */
export const forgeContext = createRouterContext<LoaderContext>();

/** What a route module's `loader` receives. */
export interface LoaderArgs {
  request: Request;
  params: Record<string, string | undefined>;
  ctx: LoaderContext;
}

export type ViewerStore = {
  get(): Viewer | null;
  set(viewer: Viewer | null): void;
  subscribe(listener: () => void): () => void;
};

const same = (a: Viewer | null, b: Viewer | null) => a === b || (a !== null && b !== null && a.userId === b.userId && a.email === b.email && a.name === b.name);

export function createViewerStore(initial: Viewer | null): ViewerStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (same(value, next)) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
