import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturn,
  type OptionalArgs,
} from "@archlast-forge/runtime";
import type { QueryClient } from "@tanstack/query-core";
import { createTRPCUntypedClient, createWSClient, httpBatchLink, splitLink, wsLink, type TRPCUntypedClient } from "@trpc/client";
import { createAuthClient } from "better-auth/client";

export type QueryUpdate<T = unknown> = { value: T } | { error: string };

/** Same mapping as the server's router builder: "admin/users:get" → "admin.users.get". */
export const procedurePath = (name: string) => name.replace(":", "/").split("/").join(".");

export interface ClientOptions {
  /** Server origin. Defaults to the page's origin (e.g. behind a dev proxy). */
  url?: string;
  WebSocket?: typeof WebSocket;
}

type Unsubscribable = { unsubscribe(): void };

interface Watch {
  listeners: Set<(u: QueryUpdate) => void>;
  last?: QueryUpdate;
  start(): void;
  stop(): void;
}

export class ArchlastForgeClient {
  readonly url: string;
  private trpc!: TRPCUntypedClient<any>;
  private ws?: ReturnType<typeof createWSClient>;
  private watches = new Map<string, Watch>();
  private authClient?: ReturnType<typeof createAuthClient>;
  private opts: ClientOptions;

  constructor(opts: ClientOptions = {}) {
    this.opts = opts;
    this.url = (opts.url ?? globalThis.location?.origin ?? "").replace(/\/$/, "");
    this.connect();
  }

  private connect() {
    // Reconnects with backoff; each subscription's first message is a fresh result, so reconnecting refetches.
    this.ws = createWSClient({ url: `${this.url.replace(/^http/, "ws")}/trpc`, WebSocket: this.opts.WebSocket });
    this.trpc = createTRPCUntypedClient({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: wsLink({ client: this.ws }),
          false: httpBatchLink({ url: `${this.url}/trpc`, fetch: (url, init) => fetch(url, { ...(init as RequestInit), credentials: "include" }) }),
        }),
      ],
    });
    for (const w of this.watches.values()) w.start();
  }

  /** Opens a new socket, e.g. after sign-in: cookies are only sent on the WebSocket handshake. */
  reconnect() {
    for (const w of this.watches.values()) w.stop();
    void this.ws?.close();
    this.connect();
  }

  close() {
    for (const w of this.watches.values()) w.stop();
    this.watches.clear();
    void this.ws?.close();
  }

  /** Better Auth client for this server; a change of session reconnects the socket. */
  get auth() {
    if (!this.authClient) {
      const auth = (this.authClient = createAuthClient({ baseURL: this.url, fetchOptions: { credentials: "include" } }));
      let session: string | null | undefined;
      auth.useSession.subscribe((s) => {
        if (s.isPending) return;
        const id = s.data?.session.id ?? null;
        if (session !== undefined && id !== session) this.reconnect();
        session = id;
      });
    }
    return this.authClient;
  }

  query<R extends FunctionReference<"query">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>> {
    return this.trpc.query(procedurePath(getFunctionName(ref)), args[0] ?? {}) as Promise<FunctionReturn<R>>;
  }

  mutation<R extends FunctionReference<"mutation">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>> {
    return this.trpc.mutation(procedurePath(getFunctionName(ref)), args[0] ?? {}) as Promise<FunctionReturn<R>>;
  }

  /** Actions are served as tRPC mutations. */
  action<R extends FunctionReference<"action">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>> {
    return this.trpc.mutation(procedurePath(getFunctionName(ref)), args[0] ?? {}) as Promise<FunctionReturn<R>>;
  }

  /** Live query. Identical (function, args) pairs share one server subscription. */
  watch<R extends FunctionReference<"query">>(
    ref: R,
    args: FunctionArgs<R>,
    listener: (update: QueryUpdate<FunctionReturn<R>>) => void,
  ): () => void {
    const name = getFunctionName(ref);
    const key = `${name}:${JSON.stringify(args ?? {})}`;
    let w = this.watches.get(key);
    if (!w) {
      let sub: Unsubscribable | undefined;
      const watch: Watch = {
        listeners: new Set(),
        start: () => {
          const emit = (u: QueryUpdate) => {
            watch.last = u;
            for (const l of watch.listeners) l(u);
          };
          sub = this.trpc.subscription(`_sub.${procedurePath(name)}`, args ?? {}, {
            onData: (u) => emit(u as QueryUpdate),
            onError: (e) => emit({ error: e.message }),
          });
        },
        stop: () => sub?.unsubscribe(),
      };
      this.watches.set(key, (w = watch));
      w.start();
    }
    const watch = w;
    watch.listeners.add(listener as (u: QueryUpdate) => void);
    if (watch.last) listener(watch.last as QueryUpdate<FunctionReturn<R>>);
    return () => {
      watch.listeners.delete(listener as (u: QueryUpdate) => void);
      if (watch.listeners.size) return;
      watch.stop();
      this.watches.delete(key);
    };
  }
}

// ---- TanStack Query integration ----

export const queryKey = (ref: FunctionReference<"query">, args: unknown) => ["archlast-forge", getFunctionName(ref), args ?? {}] as const;

/** Pushes live results of a query into a TanStack QueryClient under `queryKey(ref, args)`. */
export function syncQuery<R extends FunctionReference<"query">>(queryClient: QueryClient, client: ArchlastForgeClient, ref: R, args: FunctionArgs<R>) {
  const key = queryKey(ref, args);
  return client.watch(ref, args, (u) => {
    if ("value" in u) queryClient.setQueryData(key, u.value);
    else queryClient.getQueryCache().find({ queryKey: key })?.setState({ status: "error", error: new Error(u.error), fetchStatus: "idle" });
  });
}
