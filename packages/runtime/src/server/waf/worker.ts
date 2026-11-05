// A WAF thread: it holds one Waf (one WASM instance, a good 100 MB once the rules are loaded) and answers inspection requests from the server
// one after another. Inspecting costs about a millisecond of CPU, and more for a body, so it runs here and the server's thread keeps serving.
import { Waf, type Explained, type Verdict, type WafMode } from "./engine";
import type { WafRequest } from "./transaction";

declare const self: Worker;

/** What crosses the thread boundary: headers as an array, which structured clone can copy. */
export type WireRequest = Omit<WafRequest, "headers"> & { headers: [string, string][] };
export type WorkerRequest = { t: "init"; rules: string; mode: WafMode } | { t: "inspect"; id: number; req: WireRequest; body?: Uint8Array; explain?: boolean };
export type WorkerReply = { t: "ready" } | { t: "fatal"; error: string } | { t: "verdict"; id: number; verdict: Verdict; explained?: Explained } | { t: "failed"; id: number; error: string };

let waf: Waf | undefined;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.t === "init") {
    try {
      waf = await Waf.create({ rules: msg.rules, mode: msg.mode });
      self.postMessage({ t: "ready" } satisfies WorkerReply);
    } catch (err) {
      self.postMessage({ t: "fatal", error: (err as Error).message } satisfies WorkerReply);
    }
    return;
  }
  try {
    if (!waf) throw new Error("The WAF isn't ready");
    if (msg.explain) {
      const explained = waf.explain(msg.req, msg.body);
      self.postMessage({ t: "verdict", id: msg.id, verdict: explained.verdict, explained } satisfies WorkerReply);
    } else self.postMessage({ t: "verdict", id: msg.id, verdict: waf.inspect(msg.req, msg.body) } satisfies WorkerReply);
  } catch (err) {
    self.postMessage({ t: "failed", id: msg.id, error: (err as Error).message } satisfies WorkerReply);
  }
};
