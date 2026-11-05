// The server's one handle on the web application firewall, whether it is on or not: it can be switched on, off and reconfigured while the
// server runs (a new set of threads starts beside the old ones and takes over; the old ones finish what they were given), it keeps what the
// WAF has done for the dashboard and /metrics, and it can run a request the dashboard describes through the rules without counting it.
import { HttpError } from "../rpc";
import type { WafConfig } from "../config";
import { log } from "../logger";
import { WafGate, type Outcome } from "./gate";
import type { ThreadInfo } from "./pool";
import { INBOUND_THRESHOLD } from "./rules";
import { WafStats } from "./stats";

/** What the dashboard sends to try a request: the target as a path with its query, headers by name, a body as text. */
export interface TestRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TestResult {
  /** What this server would do with it now: `blocked` and `allowed` are the rules' decision; `detected` is detect mode seeing a match. */
  action: "allowed" | "blocked" | "detected";
  /** The anomaly score the matches add up to, and the score at which a request is stopped. */
  score: number;
  threshold: number;
  rules: { id: number; message: string; severity: number }[];
  /** Why a real request like this one is never inspected (the engine's own path, an ignored path). The rules were still run, to show what they'd do. */
  skipped?: string;
  /** False when the body was over the limit, so the rules saw the URL and headers only. */
  bodyInspected: boolean;
  mode: WafConfig["mode"];
}

/** The settings the dashboard shows and edits, as the WAF's own values. */
export const settingsOf = (c: WafConfig) => ({
  mode: c.mode,
  paranoia: c.paranoia,
  workers: c.workers,
  maxBodyKb: Math.round(c.maxBodyBytes / 1024),
  ignorePaths: c.ignorePaths,
  disabledRules: c.disabledRules,
});

const same = (a: WafConfig, b: WafConfig) => JSON.stringify(a) === JSON.stringify(b);

export class Firewall {
  readonly stats = new WafStats();
  private gate?: WafGate;
  /** Changes run one after another: each starts its threads before the one before it has to be undone. */
  private queue: Promise<unknown> = Promise.resolve();

  /** `worker` is the module the WAF threads run (the server names it, as it does the telemetry worker's). */
  constructor(
    private worker: URL,
    private apiDocsPath?: string,
  ) {}

  get enabled() {
    return this.gate !== undefined;
  }

  get config(): WafConfig | undefined {
    return this.gate?.config;
  }

  /**
   * Makes the WAF `config`, or switches it off with undefined. The new threads load their rules before anything changes, so rules that
   * don't work leave the WAF as it was and reject here with the reason.
   */
  apply(config: WafConfig | undefined): Promise<void> {
    const run = this.queue.then(() => this.swap(config));
    this.queue = run.catch(() => {});
    return run;
  }

  private async swap(config: WafConfig | undefined) {
    const old = this.gate;
    if (!config) {
      if (!old) return;
      this.gate = undefined;
      old.retire();
      log("info", "web application firewall off");
      return;
    }
    if (old && same(old.config, config)) return;
    const next = await WafGate.start(this.worker, config, this.apiDocsPath);
    this.gate = next;
    old?.retire();
    log("info", `web application firewall ${old ? "changed" : "on"}: ${config.mode}, paranoia ${config.paranoia}, ${config.workers} thread${config.workers === 1 ? "" : "s"}`);
  }

  /** Inspects a request (anything the engine hands out), counts what came of it and logs what was stopped. Passes what it isn't asked to look at. */
  async check(req: Request, url: URL, client: { address: string; port: number }, serverPort: number, readLimit: number, requestId: string): Promise<Outcome> {
    const gate = this.gate;
    if (!gate || gate.skips(req.method, url.pathname)) return { kind: "pass" };
    const started = performance.now();
    const outcome = await gate.check(req, url, client, serverPort, readLimit);
    const ms = performance.now() - started;
    // The query string stays out of the log and the events: it may hold a token.
    const where = { requestId, method: req.method, path: url.pathname, ip: client.address, ms };
    if (outcome.kind === "block") {
      const event = this.stats.flagged("blocked", { ...where, rules: outcome.verdict.rules });
      log("warn", "web application firewall blocked a request", { ...where, ruleId: outcome.verdict.ruleId, score: event.score, rules: outcome.verdict.rules.map((r) => `${r.id} ${r.message}`) });
    } else if (outcome.kind === "error") {
      this.stats.flagged("error", { ...where, error: outcome.error });
      log("error", "web application firewall couldn't inspect a request", { ...where, error: outcome.error, refused: outcome.refuse });
    } else if (outcome.detected) {
      const event = this.stats.flagged("detected", { ...where, rules: outcome.detected.rules });
      log("warn", "web application firewall: the rules would stop this request", { ...where, score: event.score, rules: outcome.detected.rules.map((r) => `${r.id} ${r.message}`) });
    } else this.stats.allowed(ms);
    return outcome;
  }

  /** Runs a described request through the rules, without counting it, to see what they make of it. */
  async test(input: TestRequest): Promise<TestResult> {
    const gate = this.gate;
    if (!gate) throw new HttpError("BAD_REQUEST", "The firewall is off: switch it on to try requests against its rules");
    const method = (input.method ?? "GET").toUpperCase();
    if (!/^[A-Z]{3,10}$/.test(method)) throw new HttpError("BAD_REQUEST", `"${input.method}" isn't an HTTP method`);
    const typed = input.path?.trim() || "/";
    if (!typed.startsWith("/")) throw new HttpError("BAD_REQUEST", "The path starts with /, like /rpc/todos:list?args=%7B%7D");
    // As a browser would send what was typed: spaces and the like percent-encoded, the rest as it is.
    const parsed = new URL(typed, "http://localhost");
    const target = parsed.pathname + parsed.search;
    const headers = Object.entries(input.headers ?? {})
      .filter(([name, value]) => name.trim() && typeof value === "string")
      .map(([name, value]) => [name.trim().toLowerCase(), value] as [string, string]);
    // A request has these in practice; without them the protocol rules would have something to say about the test and not about the content.
    for (const [name, value] of [["host", "localhost"], ["user-agent", "Mozilla/5.0"]] as const) if (!headers.some(([n]) => n === name)) headers.push([name, value]);
    const body = method === "GET" || method === "HEAD" || !input.body ? undefined : new TextEncoder().encode(input.body);
    const pathname = parsed.pathname;
    const result = await gate.explain({ method, url: target, protocol: "HTTP/1.1", headers, remoteAddr: "203.0.113.9", remotePort: 40000, serverPort: 0 }, body);
    const action = result.verdict.action === "block" ? "blocked" : result.verdict.action === "detected" ? "detected" : "allowed";
    const skipped = gate.skipReason(method, pathname);
    return {
      action,
      score: result.score,
      threshold: INBOUND_THRESHOLD,
      rules: result.rules.map((r) => ({ id: r.id, message: r.message, severity: r.severity })),
      ...(skipped && { skipped }),
      bodyInspected: result.bodyInspected,
      mode: gate.config.mode,
    };
  }

  /** Everything the Firewall page shows. */
  snapshot(minutes?: number) {
    const gate = this.gate;
    const threads: ThreadInfo[] = gate?.threads() ?? [];
    return {
      enabled: gate !== undefined,
      settings: gate ? settingsOf(gate.config) : null,
      onSince: gate?.startedAt ?? null,
      threads,
      threshold: INBOUND_THRESHOLD,
      ...this.stats.snapshot(minutes),
    };
  }

  close() {
    this.gate?.close();
    this.gate = undefined;
  }
}
