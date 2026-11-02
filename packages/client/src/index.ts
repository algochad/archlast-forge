import {
  ForgeError,
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturn,
  type Id,
  type OptionalArgs,
  type PaginationOptions,
  type PaginationResult,
} from "@archlast/forge-runtime";
import type { QueryClient } from "@tanstack/query-core";
import { createAuthClient } from "better-auth/client";

export { ForgeError };

/** A live query's latest state. Errors carry the server's request id, to look up in its logs. */
export type QueryUpdate<T = unknown> = { value: T } | { error: string; data?: unknown; requestId?: string };

/** References a client may call: internal functions aren't exposed. */
export type PublicQuery = FunctionReference<"query", any, any, "public">;
export type PublicMutation = FunctionReference<"mutation", any, any, "public">;
export type PublicAction = FunctionReference<"action", any, any, "public">;

export interface ClientOptions {
  /** Server origin. Defaults to the page's origin (e.g. behind a dev proxy). */
  url?: string;
  WebSocket?: typeof WebSocket;
  /**
   * Headers for every call and for the live socket's handshake, asked for each time they are needed, so a session that changes is picked up.
   * For clients without browser cookies: a React Native app sends the session cookie it keeps in secure storage, `() => ({ cookie })`. The
   * socket passes them the way React Native's WebSocket takes them, `new WebSocket(url, undefined, { headers })`; a browser can't set
   * handshake headers and ignores them.
   */
  headers?: () => Record<string, string> | undefined | Promise<Record<string, string> | undefined>;
  /** Better Auth client plugins for `client.auth`, e.g. `expoClient` from @better-auth/expo on React Native. */
  authPlugins?: unknown[];
}

interface Watch {
  listeners: Set<(u: QueryUpdate) => void>;
  last?: QueryUpdate;
  start(): void;
  stop(): void;
}

/** The signed-in user, from Better Auth. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** What the server sends when a call or subscription fails. `data` is what a function threw as a ForgeError. */
export interface ErrorBody {
  message: string;
  code: string;
  data?: unknown;
  requestId?: string;
}

/** A ForgeError when the function threw one, otherwise an Error with the server's code; the request id is attached either way. */
export function toClientError(e: ErrorBody): Error & { code?: string; requestId?: string } {
  const err = e.data !== undefined ? new ForgeError(e.data) : new Error(e.message);
  return Object.assign(err, { code: e.code, requestId: e.requestId });
}

export const updateError = (u: Extract<QueryUpdate, { error: string }>) =>
  Object.assign(u.data !== undefined ? new ForgeError(u.data) : new Error(u.error), { requestId: u.requestId });

type Handlers = { onData(update: QueryUpdate): void; onError(error: ErrorBody): void };

/**
 * The live-query socket: opens on the first subscription, subscribes again after a dropped connection (each subscription's first
 * message is a fresh result, so reconnecting refetches), and backs off between attempts.
 */
class LiveSocket {
  private socket?: WebSocket;
  private subscriptions = new Map<string, Handlers & { name: string; args: unknown }>();
  private next = 0;
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  private url: string;
  private WebSocketImpl?: typeof WebSocket;
  private headers?: ClientOptions["headers"];
  /** Waiting for the headers before a socket opens. */
  private opening = false;

  constructor(url: string, WebSocketImpl?: typeof WebSocket, headers?: ClientOptions["headers"]) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.headers = headers;
  }

  subscribe(name: string, args: unknown, handlers: Handlers) {
    const id = String(++this.next);
    this.subscriptions.set(id, { ...handlers, name, args });
    if (this.socket?.readyState === 1) this.send({ type: "subscribe", id, name, args });
    else this.open();
    return () => {
      if (!this.subscriptions.delete(id)) return;
      if (this.socket?.readyState === 1) this.send({ type: "unsubscribe", id });
    };
  }

  /** Drops the socket; subscriptions stay and are sent again on the next one. */
  restart() {
    clearTimeout(this.timer);
    this.attempts = 0;
    const old = this.socket;
    this.socket = undefined;
    old?.close();
    if (this.subscriptions.size) this.open();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.subscriptions.clear();
    this.socket?.close();
  }

  private send(message: object) {
    this.socket?.send(JSON.stringify(message));
  }

  private open() {
    if (this.closed || this.socket || this.timer || this.opening) return;
    if (!this.headers) return this.connect();
    this.opening = true;
    Promise.resolve()
      .then(() => this.headers!())
      .then(
        (headers) => ((this.opening = false), this.connect(headers)),
        () => ((this.opening = false), this.connect()),
      );
  }

  private connect(headers?: Record<string, string>) {
    if (this.closed || this.socket || this.timer) return;
    const Impl = (this.WebSocketImpl ?? WebSocket) as unknown as new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }) => WebSocket;
    const socket = (this.socket = headers ? new Impl(this.url, undefined, { headers }) : new Impl(this.url));
    socket.onopen = () => {
      this.attempts = 0;
      for (const [id, { name, args }] of this.subscriptions) this.send({ type: "subscribe", id, name, args });
    };
    socket.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: "data"; id: string; data: QueryUpdate } | { type: "error"; id: string; error: ErrorBody };
      const sub = this.subscriptions.get(m.id);
      if (!sub) return;
      if (m.type === "data") return sub.onData(m.data);
      this.subscriptions.delete(m.id); // the server ended it
      sub.onError(m.error);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return; // replaced by restart()
      this.socket = undefined;
      if (this.closed || !this.subscriptions.size) return;
      const delay = Math.min(10_000, 250 * 2 ** this.attempts++) * (0.5 + Math.random() / 2);
      this.timer = setTimeout(() => ((this.timer = undefined), this.open()), delay);
    };
  }
}

export class ArchlastForgeClient {
  readonly url: string;
  private live: LiveSocket;
  private watches = new Map<string, Watch>();
  private authClient?: ReturnType<typeof createAuthClient>;
  private headers?: ClientOptions["headers"];
  private authPlugins?: unknown[];
  private sessionListeners = new Set<(user: SessionUser | null) => void>();

  constructor(opts: ClientOptions = {}) {
    this.url = (opts.url ?? globalThis.location?.origin ?? "").replace(/\/$/, "");
    this.headers = opts.headers;
    this.authPlugins = opts.authPlugins;
    this.live = new LiveSocket(`${this.url.replace(/^http/, "ws")}/rpc`, opts.WebSocket, opts.headers);
  }

  /** Opens a new socket, e.g. after sign-in: cookies are only sent on the WebSocket handshake. */
  reconnect() {
    this.live.restart();
  }

  close() {
    for (const w of this.watches.values()) w.stop();
    this.watches.clear();
    this.live.close();
  }

  /**
   * Calls `listener` with the signed-in user (or null) each time the browser learns the session: after sign-in, sign-out or a reload.
   * Only fires once something uses `auth`; nothing here asks the server for the session by itself.
   */
  onSessionChange(listener: (user: SessionUser | null) => void): () => void {
    this.sessionListeners.add(listener);
    return () => void this.sessionListeners.delete(listener);
  }

  /** Better Auth client for this server; a change of session reconnects the socket. */
  get auth() {
    if (!this.authClient) {
      const auth = (this.authClient = createAuthClient({ baseURL: this.url, fetchOptions: { credentials: "include" }, ...(this.authPlugins && { plugins: this.authPlugins as never }) }));
      let session: string | null | undefined;
      auth.useSession.subscribe((s) => {
        if (s.isPending) return;
        const id = s.data?.session.id ?? null;
        if (session !== undefined && id !== session) this.reconnect();
        session = id;
        for (const l of this.sessionListeners) l(s.data?.user ?? null);
      });
    }
    return this.authClient;
  }

  private async call(ref: FunctionReference<any>, args: unknown) {
    const res = await fetch(`${this.url}/rpc/${encodeURI(getFunctionName(ref))}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...(await this.headers?.()) },
      body: JSON.stringify(args ?? {}),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: ErrorBody; message?: string } | null;
    if (!res.ok || body?.error) {
      if (body?.error) throw toClientError(body.error);
      // Answers that come from the server's front door (too many requests, shutting down) are `{ message }` with no error envelope.
      const code = res.status === 429 ? "TOO_MANY_REQUESTS" : res.status === 503 ? "SERVICE_UNAVAILABLE" : "INTERNAL_SERVER_ERROR";
      const retryAfter = Number(res.headers.get("retry-after"));
      throw Object.assign(toClientError({ message: body?.message ?? `${res.status} ${res.statusText}`, code }), retryAfter > 0 ? { retryAfter } : {});
    }
    return body?.result;
  }

  query<R extends PublicQuery>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>> {
    return this.call(ref, args[0]) as Promise<FunctionReturn<R>>;
  }

  mutation<R extends PublicMutation>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>> {
    return this.call(ref, args[0]) as Promise<FunctionReturn<R>>;
  }

  action<R extends PublicAction>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>> {
    return this.call(ref, args[0]) as Promise<FunctionReturn<R>>;
  }

  /**
   * Uploads a file through a mutation that returns `ctx.storage.generateUploadUrl()`, straight to storage.
   * Resolves to the new `_storage` id, to save with another mutation.
   */
  async uploadFile<R extends FunctionReference<"mutation", { contentType?: string }, { uploadUrl: string; storageId: Id<"_storage"> }, "public">>(
    generateUploadUrl: R,
    file: Blob,
  ): Promise<Id<"_storage">> {
    const contentType = file.type || undefined;
    const { uploadUrl, storageId } = await this.mutation(generateUploadUrl, ...([{ contentType }] as OptionalArgs<R>));
    const res = await fetch(uploadUrl, { method: "PUT", body: file, headers: contentType ? { "content-type": contentType } : {} });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return storageId;
  }

  /** Live query. Identical (function, args) pairs share one server subscription. */
  watch<R extends PublicQuery>(ref: R, args: FunctionArgs<R>, listener: (update: QueryUpdate<FunctionReturn<R>>) => void): () => void {
    const name = getFunctionName(ref);
    const key = `${name}:${JSON.stringify(args ?? {})}`;
    let w = this.watches.get(key);
    if (!w) {
      let unsubscribe: (() => void) | undefined;
      const watch: Watch = {
        listeners: new Set(),
        start: () => {
          const emit = (u: QueryUpdate) => {
            watch.last = u;
            for (const l of watch.listeners) l(u);
          };
          unsubscribe = this.live.subscribe(name, args ?? {}, {
            onData: emit,
            onError: (e) => emit({ error: e.message, data: e.data, requestId: e.requestId }),
          });
        },
        stop: () => unsubscribe?.(),
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
export function syncQuery<R extends PublicQuery>(queryClient: QueryClient, client: ArchlastForgeClient, ref: R, args: FunctionArgs<R>) {
  const key = queryKey(ref, args);
  return client.watch(ref, args, (u) => {
    if ("value" in u) queryClient.setQueryData(key, u.value);
    else queryClient.getQueryCache().find({ queryKey: key })?.setState({ status: "error", error: updateError(u), fetchStatus: "idle" });
  });
}

// ---- pagination ----

/** A query taking `paginationOpts` and returning `ctx.db.query(...).paginate(paginationOpts)`. */
export type PaginatedQuery = FunctionReference<"query", { paginationOpts: PaginationOptions }, PaginationResult<any>, "public">;
export type PaginatedArgs<R extends PaginatedQuery> = Omit<FunctionArgs<R>, "paginationOpts">;
export type PaginatedItem<R extends PaginatedQuery> = FunctionReturn<R> extends PaginationResult<infer T> ? T : never;

/**
 * Args for a growing window: one live query for the first `numItems` items. Loading more widens the window,
 * so every loaded item stays live and nothing is duplicated or skipped when items are inserted or removed.
 */
export const windowArgs = <A extends object>(args: A, numItems: number) => ({ ...args, paginationOpts: { numItems, cursor: null } });

/** Args for numbered page `page` (from 1) of `pageSize` items, with the total: `{ page, isDone, continueCursor, total }`. */
export function pageArgs<A extends object>(args: A, page: number, pageSize: number) {
  if (!Number.isInteger(page) || page < 1) throw new Error(`page must be an integer from 1, got ${page}`);
  return { ...args, paginationOpts: { numItems: pageSize, cursor: null, offset: (page - 1) * pageSize, withTotal: true } };
}
