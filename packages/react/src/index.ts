import {
  queryKey,
  syncQuery,
  updateError,
  windowArgs,
  type ArchlastForgeClient,
  type PaginatedArgs,
  type PaginatedItem,
  type PaginatedQuery,
  type PublicAction,
  type PublicMutation,
  type PublicQuery,
} from "@archlast-forge/client";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturn, type Id, type OptionalArgs } from "@archlast-forge/runtime";
import { QueryClient, QueryClientProvider, skipToken, useQueryClient, useQuery as useTanstackQuery } from "@tanstack/react-query";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

export { ArchlastForgeClient, ForgeError, type ClientOptions, type QueryUpdate } from "@archlast-forge/client";

const ClientContext = createContext<ArchlastForgeClient | null>(null);

export function ArchlastForgeProvider(props: { client: ArchlastForgeClient; queryClient?: QueryClient; children?: ReactNode }) {
  const [queryClient] = useState(() => props.queryClient ?? new QueryClient());
  return createElement(
    ClientContext.Provider,
    { value: props.client },
    createElement(QueryClientProvider, { client: queryClient }, props.children),
  );
}

export function useArchlastForge(): ArchlastForgeClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("Wrap your app in <ArchlastForgeProvider client={...}>");
  return client;
}

type QueryArgsOrSkip<R extends PublicQuery> = keyof FunctionArgs<R> extends never ? [args?: FunctionArgs<R> | "skip"] : [args: FunctionArgs<R> | "skip"];

/**
 * Live query: undefined until the first result, then re-renders on every change. Pass "skip" to not subscribe.
 * Errors throw to the nearest error boundary (a ForgeError when the function threw one).
 */
export function useQuery<R extends PublicQuery>(ref: R, ...args: QueryArgsOrSkip<R>): FunctionReturn<R> | undefined {
  const client = useArchlastForge();
  const queryClient = useQueryClient();
  const skip = args[0] === "skip";
  const queryArgs = skip ? {} : (args[0] ?? {});
  const key = queryKey(ref, queryArgs);
  const hash = JSON.stringify(key);
  useEffect(() => (skip ? undefined : syncQuery(queryClient, client, ref, queryArgs as never)), [client, queryClient, hash, skip]);
  // Results arrive over the subscription, so TanStack never fetches.
  const { data, error } = useTanstackQuery({ queryKey: key, queryFn: skipToken, staleTime: Infinity, enabled: !skip });
  if (error) throw error;
  return skip ? undefined : (data as FunctionReturn<R> | undefined);
}

export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

/**
 * Live paginated list. The query must take `paginationOpts` and return `.paginate(paginationOpts)`.
 * `loadMore(n)` widens one live window, so every loaded item stays up to date.
 */
export function usePaginatedQuery<R extends PaginatedQuery>(ref: R, args: PaginatedArgs<R> | "skip", opts: { initialNumItems: number }) {
  const [numItems, setNumItems] = useState(opts.initialNumItems);
  const argsHash = JSON.stringify(args);
  useEffect(() => {
    setNumItems(opts.initialNumItems); // new args start over
  }, [argsHash]);
  const result = useQuery(ref as unknown as PublicQuery, ...([args === "skip" ? "skip" : windowArgs(args, numItems)] as [any]));
  const page = result as { page: PaginatedItem<R>[]; isDone: boolean } | undefined;
  const status: PaginationStatus = !page ? "LoadingFirstPage" : page.isDone ? "Exhausted" : page.page.length < numItems ? "LoadingMore" : "CanLoadMore";
  // Keep showing the previous window while a wider one loads.
  const [last, setLast] = useState<PaginatedItem<R>[]>([]);
  useEffect(() => {
    if (page) setLast(page.page);
  }, [page]);
  return {
    results: page?.page ?? last,
    status,
    isLoading: status === "LoadingFirstPage" || status === "LoadingMore",
    loadMore: useCallback((n: number) => setNumItems((x) => x + n), []),
  };
}

/** Reads and writes the locally cached results of live queries, for optimistic updates. */
export interface LocalStore {
  getQuery<Q extends PublicQuery>(ref: Q, args: FunctionArgs<Q>): FunctionReturn<Q> | undefined;
  setQuery<Q extends PublicQuery>(ref: Q, args: FunctionArgs<Q>, value: FunctionReturn<Q> | undefined): void;
}

type MutationFn<R extends PublicMutation> = ((...args: OptionalArgs<R>) => Promise<FunctionReturn<R>>) & {
  /** Applies `update` to local query results right away; it's undone if the mutation fails, and live results replace it either way. */
  withOptimisticUpdate(update: (store: LocalStore, args: FunctionArgs<R>) => void): (...args: OptionalArgs<R>) => Promise<FunctionReturn<R>>;
};

export function useMutation<R extends PublicMutation>(ref: R): MutationFn<R> {
  const client = useArchlastForge();
  const queryClient = useQueryClient();
  const name = getFunctionName(ref);
  return useMemo(() => {
    const run = (...args: OptionalArgs<R>) => client.mutation(ref, ...args);
    return Object.assign(run, {
      withOptimisticUpdate: (update: (store: LocalStore, args: FunctionArgs<R>) => void) => async (...args: OptionalArgs<R>) => {
        const before = new Map<string, { key: readonly unknown[]; value: unknown }>();
        const store: LocalStore = {
          getQuery: (q, a) => queryClient.getQueryData(queryKey(q, a)) as never,
          setQuery: (q, a, value) => {
            const key = queryKey(q, a);
            const hash = JSON.stringify(key);
            if (!before.has(hash)) before.set(hash, { key, value: queryClient.getQueryData(key) });
            queryClient.setQueryData(key, value);
          },
        };
        update(store, (args[0] ?? {}) as FunctionArgs<R>);
        try {
          return await client.mutation(ref, ...args);
        } catch (e) {
          for (const { key, value } of before.values()) queryClient.setQueryData(key, value);
          throw e;
        }
      },
    }) as MutationFn<R>;
  }, [client, queryClient, name]);
}

export function useAction<R extends PublicAction>(ref: R) {
  const client = useArchlastForge();
  const name = getFunctionName(ref);
  return useCallback((...args: OptionalArgs<R>) => client.action(ref, ...args), [client, name]);
}

/** `upload(file)` → the new `_storage` id, via your mutation that returns `ctx.storage.generateUploadUrl()`. */
export function useUploadFile<R extends FunctionReference<"mutation", { contentType?: string }, { uploadUrl: string; storageId: Id<"_storage"> }, "public">>(
  generateUploadUrl: R,
) {
  const client = useArchlastForge();
  const name = getFunctionName(generateUploadUrl);
  return useCallback((file: Blob) => client.uploadFile(generateUploadUrl, file), [client, name]);
}

/** The Better Auth client: signIn, signUp, signOut, … */
export const useAuth = () => useArchlastForge().auth;

/** What the session is on the server and during hydration: still loading. Sign-in state arrives in the browser. */
const PENDING_SESSION = { data: null, error: null, isPending: true, isRefetching: false, refetch: async () => {} };

export function useSession() {
  const atom = useArchlastForge().auth.useSession;
  type State = ReturnType<typeof atom.get>;
  return useSyncExternalStore((cb) => atom.listen(cb), () => atom.get(), () => PENDING_SESSION as State);
}

export { updateError };
