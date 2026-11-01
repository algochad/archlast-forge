import { ArchlastForgeClient, updateError, type PublicQuery } from "@archlast/forge-client";
import type { FunctionArgs, FunctionReturn } from "@archlast/forge-runtime";

export { ArchlastForgeClient, ForgeError, pageArgs, windowArgs } from "@archlast/forge-client";

/** The Svelte store contract, so no dependency on svelte itself: works with `$store` in Svelte 4 and 5. */
export interface Readable<T> {
  subscribe(run: (value: T) => void): () => void;
}

export type QueryState<T> = { data: T | undefined; error: Error | undefined; isLoading: boolean };

/**
 * Live query as a store: `const todos = query(client, api.todos.listByList, { listId })`, then `$todos.data`.
 * The server subscription opens with the first subscriber and closes with the last.
 */
export function query<R extends PublicQuery>(client: ArchlastForgeClient, ref: R, args: FunctionArgs<R> = {} as FunctionArgs<R>): Readable<QueryState<FunctionReturn<R>>> {
  let state: QueryState<FunctionReturn<R>> = { data: undefined, error: undefined, isLoading: true };
  const subscribers = new Set<(v: QueryState<FunctionReturn<R>>) => void>();
  let stop: (() => void) | undefined;
  return {
    subscribe(run) {
      subscribers.add(run);
      run(state);
      stop ??= client.watch(ref, args, (u) => {
        state = "value" in u ? { data: u.value, error: undefined, isLoading: false } : { ...state, error: updateError(u), isLoading: false };
        for (const s of subscribers) s(state);
      });
      return () => {
        subscribers.delete(run);
        if (subscribers.size) return;
        stop?.();
        stop = undefined;
      };
    },
  };
}

/** The Better Auth session as a store. */
export function session(client: ArchlastForgeClient): Readable<ReturnType<ArchlastForgeClient["auth"]["useSession"]["get"]>> {
  const atom = client.auth.useSession;
  return { subscribe: (run) => atom.subscribe(run) };
}
