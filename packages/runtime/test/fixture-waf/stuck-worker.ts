// A WAF thread that starts and then never answers, as one stuck inside a rule would.
declare const self: Worker;
self.onmessage = (e: MessageEvent<{ t: string }>) => {
  if (e.data.t === "init") self.postMessage({ t: "ready" });
};
