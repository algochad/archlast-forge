import { ArchlastForgeClient, updateError, type PublicAction, type PublicMutation, type PublicQuery } from "@archlast/forge-client";
import { getFunctionName, type FunctionArgs, type FunctionReturn, type OptionalArgs } from "@archlast/forge-runtime";
import { getCurrentScope, inject, onScopeDispose, ref, shallowRef, toValue, watch, type App, type MaybeRefOrGetter, type Ref } from "vue";

export { ArchlastForgeClient, ForgeError } from "@archlast/forge-client";

const KEY = Symbol("archlast-forge");

/** app.use(archlastForge(client)) */
export const archlastForge = (client: ArchlastForgeClient) => ({ install: (app: App) => app.provide(KEY, client) });

export function useArchlastForge(): ArchlastForgeClient {
  const client = inject<ArchlastForgeClient>(KEY);
  if (!client) throw new Error("Install the plugin first: app.use(archlastForge(client))");
  return client;
}

/**
 * Live query. `data` updates on every change; args may be a ref or getter (re-subscribes when they change),
 * or "skip". Stops when the component (or effect scope) is disposed.
 */
export function useQuery<R extends PublicQuery>(query: R, args: MaybeRefOrGetter<FunctionArgs<R> | "skip"> = {} as FunctionArgs<R>) {
  const client = useArchlastForge();
  const data = shallowRef<FunctionReturn<R> | undefined>(undefined) as Ref<FunctionReturn<R> | undefined>;
  const error = shallowRef<Error | undefined>(undefined);
  let stop: (() => void) | undefined;
  watch(
    () => JSON.stringify(toValue(args)),
    () => {
      stop?.();
      stop = undefined;
      const a = toValue(args);
      if (a === "skip") return void (data.value = undefined);
      stop = client.watch(query, a, (u) => {
        if ("value" in u) {
          data.value = u.value;
          error.value = undefined;
        } else error.value = updateError(u);
      });
    },
    { immediate: true },
  );
  if (getCurrentScope()) onScopeDispose(() => stop?.());
  return { data, error, isLoading: () => data.value === undefined && !error.value };
}

export function useMutation<R extends PublicMutation>(mutation: R) {
  const client = useArchlastForge();
  getFunctionName(mutation); // fail early on a bad reference
  return (...args: OptionalArgs<R>) => client.mutation(mutation, ...args);
}

export function useAction<R extends PublicAction>(action: R) {
  const client = useArchlastForge();
  getFunctionName(action);
  return (...args: OptionalArgs<R>) => client.action(action, ...args);
}

/** Reactive Better Auth session. */
export function useSession() {
  const atom = useArchlastForge().auth.useSession;
  const session = ref(atom.get());
  const off = atom.listen((s) => (session.value = s));
  if (getCurrentScope()) onScopeDispose(off);
  return session;
}
