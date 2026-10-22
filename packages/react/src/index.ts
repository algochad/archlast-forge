import { queryKey, syncQuery, type ArchlastForgeClient } from "@archlast-forge/client";
import { getFunctionName, type FunctionReference, type FunctionReturn, type OptionalArgs } from "@archlast-forge/runtime";
import { QueryClient, QueryClientProvider, skipToken, useQueryClient, useQuery as useTanstackQuery } from "@tanstack/react-query";
import { createContext, createElement, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

export { ArchlastForgeClient, type ClientOptions, type QueryUpdate } from "@archlast-forge/client";

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

/** Live query: undefined until the first result, then re-renders on every change. Errors throw to the nearest error boundary. */
export function useQuery<R extends FunctionReference<"query">>(ref: R, ...args: OptionalArgs<R>): FunctionReturn<R> | undefined {
  const client = useArchlastForge();
  const queryClient = useQueryClient();
  const queryArgs = args[0] ?? {};
  const key = queryKey(ref, queryArgs);
  const hash = JSON.stringify(key);
  useEffect(() => syncQuery(queryClient, client, ref, queryArgs as never), [client, queryClient, hash]);
  // Results arrive over the subscription, so TanStack never fetches.
  const { data, error } = useTanstackQuery({ queryKey: key, queryFn: skipToken, staleTime: Infinity });
  if (error) throw error;
  return data as FunctionReturn<R> | undefined;
}

export function useMutation<R extends FunctionReference<"mutation">>(ref: R) {
  const client = useArchlastForge();
  const name = getFunctionName(ref);
  return useCallback((...args: OptionalArgs<R>) => client.mutation(ref, ...args), [client, name]);
}

export function useAction<R extends FunctionReference<"action">>(ref: R) {
  const client = useArchlastForge();
  const name = getFunctionName(ref);
  return useCallback((...args: OptionalArgs<R>) => client.action(ref, ...args), [client, name]);
}

/** The Better Auth client: signIn, signUp, signOut, … */
export const useAuth = () => useArchlastForge().auth;

export function useSession() {
  const atom = useArchlastForge().auth.useSession;
  return useSyncExternalStore((cb) => atom.listen(cb), () => atom.get());
}
