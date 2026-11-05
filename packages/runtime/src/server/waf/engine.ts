// One Coraza WAF: a WASM instance with the rules loaded, answering "is this request an attack?" synchronously. Everything the engine does with
// it goes through a worker thread (worker.ts, pool.ts); this class is what runs there, and what the tests call directly.
//
// Derived from @coraza/core's wasm.ts and waf.ts (Apache-2.0, see THIRD_PARTY_NOTICES.md), with these differences:
//  - WASI is our own (wasi.ts), because Bun's `node:wasi` ends the process when Go's `main` returns.
//  - CRS's regexes always run inside the module, on Go's linear-time engine. Upstream can hand them to the host's `RegExp`, which backtracks
//    (so a crafted request can stall a rule); on Bun it is not faster either (measured: 0.95 ms against 1.06 ms for a plain GET).
//  - The memory patcher and the other adapters' paths are gone: the shipped module already asks for the memory CRS needs.
import { fileURLToPath } from "node:url";
import { Abi, utf8, type CorazaExports } from "./abi";
import { Transaction, type MatchedRule, type WafRequest } from "./transaction";
import { createWasi } from "./wasi";

export type WafMode = "block" | "detect";

export type Verdict =
  | { action: "allow" }
  /** The rules want the request stopped (block mode only). */
  | { action: "block"; ruleId: number; status: number; rules: MatchedRule[] }
  /** Detect mode: the rules matched, and the request goes on. */
  | { action: "detected"; rules: MatchedRule[] };

/** Where `@coraza/core` put the compiled module, which is the one thing the engine takes from that package. */
export async function defaultWasm(): Promise<Uint8Array> {
  let path: string;
  try {
    path = fileURLToPath(new URL("./dist/wasm/coraza.wasm", import.meta.resolve("@coraza/core/package.json")));
  } catch {
    throw new Error("The WAF needs the @coraza/core package, which isn't installed: bun add @coraza/core@0.1.0-preview.3");
  }
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/** A request's verdict with all the rules that matched it, and the anomaly score they add up to (CRS stops a request at 5). */
export interface Explained {
  verdict: Verdict;
  rules: MatchedRule[];
  score: number;
}

/** What each severity adds to a request's anomaly score in CRS: critical 5, error 4, warning 3, notice 2. */
const SCORE: Record<number, number> = { 2: 5, 3: 4, 4: 3, 5: 2 };

/** The anomaly score a set of matched rules adds up to. */
export const scoreOf = (rules: MatchedRule[]) => rules.filter(isFinding).reduce((n, r) => n + (SCORE[r.severity] ?? 0), 0);

/** What a transaction lists as matched includes CRS's own setup rules (900xxx and 901xxx: no message, severity -1) on every request: the rules that found something are the ones with a message from 911000 up. */
const found = (rules: MatchedRule[]) => rules.filter((r) => r.id >= 910000 && r.message !== "");

/** CRS's rules that add the scores up and decide (949xxx for requests, 959xxx for responses, 980xxx for the correlation line), as against the ones that looked for something. */
export const isFinding = (r: MatchedRule) => ![949, 959, 980].includes(Math.floor(r.id / 1000));

export class Waf {
  private destroyed = false;
  private constructor(
    private abi: Abi,
    private id: number,
    readonly mode: WafMode,
  ) {}

  static async create(opts: { rules: string; mode: WafMode; wasm?: Uint8Array }): Promise<Waf> {
    const module = await WebAssembly.compile((opts.wasm ?? (await defaultWasm())) as BufferSource);
    let memory: WebAssembly.Memory;
    const wasi = createWasi({ memory: () => memory, onOutput: () => {} });
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.imports,
      // Returning 0 from rx_compile makes the module use its own regex engine for every pattern.
      env: { rx_compile: () => 0, rx_match: () => 0, rx_free: () => {} },
    });
    memory = instance.exports.memory as WebAssembly.Memory;
    wasi.start(instance);
    const abi = new Abi(instance.exports as unknown as CorazaExports);
    // The engine line goes last so that it wins over whatever the rules say.
    const config = utf8(`${opts.rules}\n${opts.mode === "block" ? "SecRuleEngine On" : "SecRuleEngine DetectionOnly"}\n`);
    const id = abi.withBytes(config, (ptr, len) => abi.exports.waf_create(ptr, len));
    abi.check(id, "waf_create");
    return new Waf(abi, id, opts.mode);
  }

  inspect(req: WafRequest, body?: Uint8Array): Verdict {
    return this.run(req, body).verdict;
  }

  /** Like `inspect`, with everything that matched, also when it wasn't enough to stop the request (the dashboard's "try a request"). */
  explain(req: WafRequest, body?: Uint8Array): Explained {
    const { verdict, rules } = this.run(req, body, true);
    return { verdict, rules, score: scoreOf(rules) };
  }

  private run(req: WafRequest, body: Uint8Array | undefined, all = false): { verdict: Verdict; rules: MatchedRule[] } {
    if (this.destroyed) throw new Error("coraza: the WAF is destroyed");
    const txId = this.abi.exports.tx_create(this.id);
    this.abi.check(txId, "tx_create");
    const tx = new Transaction(this.abi, txId);
    try {
      const stopped = tx.inspect(req, body) ? tx.interruption() : undefined;
      // Without `all`, a request that matched nothing costs no JSON parse: the common case is the cheap one.
      if (stopped) {
        const rules = found(tx.matchedRules());
        return { verdict: { action: "block", ruleId: stopped.ruleId, status: stopped.status || 403, rules }, rules };
      }
      if (this.mode === "detect" || all) {
        const rules = found(tx.matchedRules());
        if (this.mode === "detect" && rules.length) return { verdict: { action: "detected", rules }, rules };
        return { verdict: { action: "allow" }, rules };
      }
      return { verdict: { action: "allow" }, rules: [] };
    } finally {
      tx.close();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abi.exports.waf_destroy(this.id);
  }
}
