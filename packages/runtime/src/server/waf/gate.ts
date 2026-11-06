// The WAF in front of the engine's HTTP server: which requests it looks at, what it hands the rules, and what comes of the answer.
import { readBytes } from "../rpc";
import type { WafConfig } from "../config";
import type { Explained, Verdict } from "./engine";
import { WafPool, type ThreadInfo } from "./pool";
import type { WireRequest } from "./worker";
import { buildRules } from "./rules";

/**
 * What the engine's own routes carry and the rules would only trip over: the dashboard edits code and the like, storage takes files, and a
 * CSP violation report quotes the script it blocked (an injection the policy stopped would otherwise lose its report to the WAF).
 */
const ENGINE_PATHS = ["/_dashboard", "/_admin", "/_storage", "/_app", "/_telemetry", "/_csp"];
/** Static files a browser asks for: nothing in them for an attacker to reach, and a page loads dozens. */
const STATIC = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|mp4|webm|mp3|wasm)$/i;

/**
 * Why the engine (or the app's files) answers this request itself, so the WAF leaves it alone, or undefined. The server says, from what it
 * actually serves: a path of that shape that it doesn't serve goes to the app's code, and is inspected like the rest.
 */
export type Owns = (method: string, path: string) => string | undefined | Promise<string | undefined>;

/** By the path's shape alone, for a firewall with no server to ask (tests, the dashboard's "Try a request" before a server says otherwise). */
export const ownsByShape: Owns = (method, path) => {
  const prefix = ENGINE_PATHS.find((p) => path === p || path.startsWith(`${p}/`));
  if (prefix) return `${prefix} is the engine's own`;
  if ((method === "GET" || method === "HEAD") && STATIC.test(path)) return "static files aren't inspected";
  return undefined;
};

export type Outcome =
  /** Let it through. `detected` lists what matched in detect mode, so the server can log it. */
  | { kind: "pass"; detected?: Extract<Verdict, { action: "detected" }> }
  | { kind: "block"; verdict: Extract<Verdict, { action: "block" }> }
  /** The WAF itself failed. In block mode the request is refused: failing open would let an attacker who can crash the WAF past it. */
  | { kind: "error"; error: string; refuse: boolean };

export class WafGate {
  private constructor(
    private pool: WafPool,
    readonly config: WafConfig,
    private ignored: string[],
    private owns: Owns,
  ) {}

  /** When this gate's threads were up. */
  readonly startedAt = Date.now();

  /**
   * Starts the WAF threads, whose code is the module at `worker` (the server names it, as it does the telemetry worker's: a bundle puts this
   * file somewhere else than the worker). Rejects when they can't start, so a bad configuration stops the engine at boot instead of leaving it
   * unguarded. `owns` says which requests the engine answers itself (the server knows, from what it serves and the loaded code).
   */
  static async start(worker: URL, config: WafConfig, owns: Owns = ownsByShape): Promise<WafGate> {
    const rules = buildRules({ paranoia: config.paranoia, disabledRules: config.disabledRules });
    const pool = await WafPool.start(worker, { rules, mode: config.mode, size: config.workers });
    return new WafGate(pool, config, config.ignorePaths.map((p) => p.replace(/\/+$/, "")), owns);
  }

  /** Why this request isn't for the WAF to look at, or undefined when it is. */
  skipReason(method: string, path: string): string | undefined | Promise<string | undefined> {
    const prefix = this.ignored.find((p) => path === p || path.startsWith(`${p}/`));
    if (prefix) return `${prefix} is in the ignored paths`;
    return this.owns(method, path);
  }

  /** Whether this request isn't for the WAF to look at. */
  async skips(method: string, path: string): Promise<boolean> {
    return (await this.skipReason(method, path)) !== undefined;
  }

  threads(): ThreadInfo[] {
    return this.pool.threadInfo();
  }

  /** Runs a request through the rules with everything reported, for the dashboard; `body` is cut off the way a real one is when it is over the limit. */
  async explain(req: WireRequest, body: Uint8Array | undefined): Promise<Explained & { bodyInspected: boolean }> {
    const inspected = body && body.length > 0 && body.length <= this.config.maxBodyBytes ? body : undefined;
    return { ...(await this.pool.explain(req, inspected)), bodyInspected: inspected !== undefined };
  }

  /** Ends this gate's threads once the requests on them are answered: it has been replaced. */
  retire() {
    this.pool.retire();
  }

  /**
   * Inspects a request. Its body is read from a copy, so the request is still whole for whoever handles it; `readLimit` is the most the
   * engine reads of any body (MAX_REQUEST_BYTES), which is also the most this buffers.
   */
  async check(req: Request, url: URL, client: { address: string; port: number }, serverPort: number, readLimit: number): Promise<Outcome> {
    try {
      const body = await this.bodyOf(req, readLimit);
      const verdict = await this.pool.inspect(
        {
          method: req.method,
          url: url.pathname + url.search,
          protocol: "HTTP/1.1",
          headers: [...req.headers],
          remoteAddr: client.address,
          remotePort: client.port,
          serverPort,
        },
        body,
      );
      if (verdict.action === "block") return { kind: "block", verdict };
      return verdict.action === "detected" ? { kind: "pass", detected: verdict } : { kind: "pass" };
    } catch (e) {
      // A body over the engine's limit is the engine's to refuse, with its own error; it does that when it reads the body.
      if ((e as { code?: string }).code === "PAYLOAD_TOO_LARGE") return { kind: "pass" };
      return { kind: "error", error: (e as Error).message, refuse: this.config.mode === "block" };
    }
  }

  private async bodyOf(req: Request, readLimit: number): Promise<Uint8Array | undefined> {
    if (req.method === "GET" || req.method === "HEAD" || !req.body) return undefined;
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > this.config.maxBodyBytes) return undefined;
    const bytes = await readBytes(req.clone(), readLimit);
    return bytes.length === 0 || bytes.length > this.config.maxBodyBytes ? undefined : bytes;
  }

  close() {
    this.pool.close();
  }
}
