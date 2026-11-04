// The client side of Forge RPC. Calls made in the same tick are sent together, over a WebSocket kept open to the service (a round trip costs
// a fraction of an HTTP request's), or, when the service can't be reached that way, as one HTTP `fetch` (wire format in wire.ts). Bun only.
import type { WireError } from "./wire";

export interface CallerOptions {
  /** Where the service listens: `http://orders:4001`. */
  url: string;
  /** The Authorization header's value. Called when a connection or request is made, so it can fail the call. */
  authorization(): string;
  /** How long calls sent together may take before every one of them still waiting fails with TIMEOUT. */
  timeoutMs: number;
  /** Most calls in one HTTP request. */
  maxItems?: number;
  /** Talk over a WebSocket when the service allows it. Default true; false always uses HTTP. */
  websocket?: boolean;
  /**
   * Called as a call is made, for one that goes over a WebSocket (an HTTP request is traced by `fetch`): returns the trace to continue
   * in the service, and is told how the call ended.
   */
  trace?(pattern: string): { traceparent: string; end(error?: string): void } | undefined;
}

/** Called once, with an error or with the value. */
export type Done = (error: WireError | null, value?: unknown) => void;

interface Item {
  pattern: string;
  body: string | undefined;
  done: Done | null;
  batch?: Batch;
  trace?: { traceparent: string; end(error?: string): void };
}
/** Calls sent together: they share a deadline, and an HTTP request's abort controller. */
interface Batch {
  open: number;
  responded: boolean;
  timer?: Timer;
  ac?: AbortController;
}

const unavailable = (url: string, pattern: string, why: string): WireError => ({ status: "error", message: `Forge RPC: ${url} did not answer ${pattern} (${why})`, code: "SERVICE_UNAVAILABLE" });

function wireOf(e: any, fallback: string): WireError {
  const code = e?.data?.code;
  if (!code) return { status: "error", message: String(e?.message ?? fallback), code: "INTERNAL_SERVER_ERROR" };
  return { status: "error", message: String(e.message), code, ...(e.data.data !== undefined && { data: e.data.data }), ...(e.data.requestId && { requestId: e.data.requestId }) };
}

/** How long a service that wouldn't take a WebSocket is left alone before another try. */
const RETRY_MS = 30_000;
/** Most calls in a WebSocket frame: half of what a server takes by default, so a frame is never refused. */
const WS_FRAME = 128;

/** `caller(pattern, input, done)` sends a call and answers `done` once; the function it returns cancels the call. `close()` ends the connection. */
export interface Caller {
  (pattern: string, input: unknown, done: Done): () => void;
  close(): void;
}

export function createCaller(options: CallerOptions): Caller {
  const base = options.url.replace(/\/+$/, "");
  const maxItems = options.maxItems ?? 32;
  let queue: Item[] = [];

  /** The call is over (answered, failed or cancelled): returns what to tell, once, or null if it already ended. */
  function settle(item: Item, error?: string): Done | null {
    const done = item.done;
    if (!done) return null;
    item.done = null;
    const batch = item.batch;
    item.trace?.end(error);
    if (batch && --batch.open === 0) {
      clearTimeout(batch.timer);
      if (!batch.responded) batch.ac?.abort(); // every call in the request is over: stop waiting for it
    }
    return done;
  }

  function finish(item: Item, error: WireError | null, value?: unknown) {
    settle(item, error ? `${error.code}: ${error.message}` : undefined)?.(error, value);
  }

  /** Gives a call the answer the service sent in `r`: `{"result":{"data"}}` or `{"error":{…}}`. */
  function answer(item: Item, r: any, why = "") {
    if (r?.result) finish(item, null, r.result.data);
    else if (r?.error) finish(item, wireOf(r.error, "Error"));
    else finish(item, unavailable(options.url, item.pattern, why || "no answer for this call"));
  }

  // ---- HTTP: one request for the calls sent together ----

  async function viaHttp(live: Item[], batch: Batch) {
    batch.ac = new AbortController();
    let names = "";
    let body = "{";
    for (let i = 0; i < live.length; i++) {
      const item = live[i]!;
      names += i ? "," + item.pattern : item.pattern;
      if (item.body !== undefined) body += (body.length > 1 ? "," : "") + '"' + i + '":' + item.body;
    }
    let authorization: string;
    try {
      authorization = options.authorization();
    } catch (e) {
      batch.responded = true;
      for (const item of live) finish(item, { status: "error", message: (e as Error).message, code: "UNAUTHORIZED" });
      return;
    }
    let results: any;
    let why = "";
    try {
      const res = await fetch(`${base}/${names}?batch=1`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json", "accept-encoding": "identity" },
        body: body + "}",
        signal: batch.ac.signal,
      });
      const text = await res.text();
      try {
        results = JSON.parse(text);
      } catch {
        why = `status ${res.status}, not JSON`;
      }
    } catch (e) {
      why = (e as Error)?.message ?? String(e);
    }
    batch.responded = true;
    for (let i = 0; i < live.length; i++) if (live[i]!.done) answer(live[i]!, Array.isArray(results) ? results[i] : results, why);
    clearTimeout(batch.timer);
  }

  // ---- WebSocket: one connection, calls tagged with an id ----

  const wsUrl = base.replace(/^http/, "ws") + "/_ws";
  let socket: WebSocket | undefined;
  let state: "idle" | "connecting" | "open" = "idle";
  let retryAt = 0;
  let nextId = 1;
  /** Calls sent and not answered. */
  const sent = new Map<number, Item>();
  /** Calls waiting for the connection to open. */
  let waiting: { items: Item[]; batch: Batch }[] = [];

  const wsUsable = () => options.websocket !== false && (state !== "idle" || Date.now() >= retryAt);

  function write(live: Item[]) {
    let frame = "[";
    for (let i = 0; i < live.length; i++) {
      const item = live[i]!;
      const id = nextId++;
      sent.set(id, item);
      // A negative id says the call has no input (null is an input of its own); the answer comes back under the positive one.
      const trace = item.trace ? "," + JSON.stringify(item.trace.traceparent) : "";
      const input = item.body !== undefined ? "," + item.body : trace ? ",null" : "";
      frame += (i ? "," : "") + "[" + (item.body === undefined ? -id : id) + "," + JSON.stringify(item.pattern) + input + trace + "]";
    }
    socket!.send(frame + "]");
  }

  /** The connection is gone. If it never opened, the service can't take a WebSocket: what waited for it goes over HTTP. */
  function down(opened: boolean, why: string) {
    const was = socket;
    socket = undefined;
    state = "idle";
    if (!opened) {
      retryAt = Date.now() + RETRY_MS;
      const held = waiting;
      waiting = [];
      for (const { items, batch } of held) void viaHttp(items.filter((i) => i.done), batch);
    }
    // A call that was sent may have run: it fails rather than being sent again.
    const lost = [...sent.values()];
    sent.clear();
    for (const item of lost) finish(item, unavailable(options.url, item.pattern, `the connection closed: ${why}`));
    if (was && was.readyState < 2) was.close();
  }

  function connect(first: Item[]) {
    let authorization: string;
    try {
      authorization = options.authorization();
    } catch (e) {
      for (const item of first) finish(item, { status: "error", message: (e as Error).message, code: "UNAUTHORIZED" });
      return false;
    }
    state = "connecting";
    let opened = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { headers: { authorization } } as never);
    } catch (e) {
      down(false, (e as Error)?.message ?? "no connection");
      return true; // what was waiting went over HTTP
    }
    socket = ws;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      state = "open";
      (ws as unknown as { unref?(): void }).unref?.(); // the calls' own timers keep the process alive while it waits for one
      const held = waiting;
      waiting = [];
      for (const { items } of held) {
        const live = items.filter((i) => i.done);
        if (live.length) write(live);
      }
    });
    ws.addEventListener("message", (event) => {
      let frame: any;
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      for (const entry of frame) {
        const item = sent.get(entry[0]);
        if (!item) continue; // answered late, after it timed out or was cancelled
        sent.delete(entry[0]);
        answer(item, entry[1]);
      }
    });
    ws.addEventListener("close", (event) => socket === ws && down(opened, (event as CloseEvent).reason || `code ${(event as CloseEvent).code}`));
    ws.addEventListener("error", () => socket === ws && down(opened, "WebSocket error"));
    return true;
  }

  function viaWs(live: Item[], batch: Batch) {
    if (state === "open") return write(live);
    waiting.push({ items: live, batch });
    if (state === "idle" && !connect(live)) waiting = [];
  }

  // ---- sending ----

  function dispatch(items: Item[]) {
    const live = items.filter((i) => i.done);
    if (!live.length) return;
    const batch: Batch = { open: live.length, responded: false };
    for (const item of live) item.batch = batch;
    batch.timer = setTimeout(() => {
      for (const item of live) finish(item, { status: "error", message: `Forge RPC: ${item.pattern} took longer than ${options.timeoutMs} ms`, code: "TIMEOUT" });
    }, options.timeoutMs);
    if (wsUsable()) viaWs(live, batch);
    else void viaHttp(live, batch);
  }

  function flush() {
    const items = queue;
    queue = [];
    const size = wsUsable() ? WS_FRAME : maxItems;
    for (let i = 0; i < items.length; i += size) dispatch(items.length > size ? items.slice(i, i + size) : items);
  }

  const call = (pattern: string, input: unknown, done: Done) => {
    const item: Item = { pattern, body: input === undefined ? undefined : JSON.stringify(input), done };
    if (options.trace && wsUsable()) item.trace = options.trace(pattern);
    if (queue.push(item) === 1) queueMicrotask(flush);
    return () => void settle(item);
  };
  /** Closes the connection. A call made after this opens a new one. */
  call.close = () => {
    if (socket) down(true, "closed by the caller");
  };
  return call;
}
