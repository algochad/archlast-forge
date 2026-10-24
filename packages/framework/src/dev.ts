import { existsSync, watch } from "node:fs";
import { join } from "node:path";

/** Runs in the browser during development: reloads when the app is rebuilt and shows build errors on top of the page. */
export const DEV_SCRIPT = `(() => {
  let overlay;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const hide = () => { overlay?.remove(); overlay = undefined; };
  const show = (title, message) => {
    hide();
    overlay = document.createElement("div");
    overlay.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;overflow:auto;background:rgba(12,12,16,.94);color:#f4f4f5;padding:32px 24px");
    overlay.innerHTML = '<div style="max-width:960px;margin:0 auto"><div style="font:600 18px system-ui,sans-serif;color:#ff6b6b;margin-bottom:14px">' + esc(title) + '</div><pre style="margin:0;white-space:pre-wrap;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace">' + esc(message) + '</pre><div style="margin-top:22px;font:12px system-ui,sans-serif;color:#9a9aa3">Fix it and save: this page reloads by itself. Esc dismisses.</div></div>';
    document.body.append(overlay);
  };
  addEventListener("keydown", (e) => e.key === "Escape" && hide());
  if (window.__FORGE_ERROR__) show(window.__FORGE_ERROR__.title, window.__FORGE_ERROR__.message);
  let lost = false;
  const es = new EventSource("/_app/__events");
  es.onerror = () => { lost = true; };
  es.onopen = () => { if (lost) location.reload(); };
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "reload") location.reload();
    else if (m.type === "error") show("Build failed", m.message);
  };
})();
`;

/** The page shown instead of the app while the build is failing. */
export function buildErrorPage(message: string): Response {
  const json = JSON.stringify({ title: "Build failed", message }).replace(/</g, "\\u003c");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Build failed</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#0c0c10"><script>window.__FORGE_ERROR__=${json}</script><script type="module" src="/_app/__dev.js"></script></body></html>`,
    { status: 500, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** Browsers connected for live reload. */
export class DevEvents {
  private clients = new Set<(chunk: string) => void>();

  response(): Response {
    let drop = () => {};
    const stream = new ReadableStream<string>({
      start: (controller) => {
        controller.enqueue(": connected\n\n"); // sends the headers, so the browser sees the stream open
        const send = (chunk: string) => controller.enqueue(chunk);
        const ping = setInterval(() => controller.enqueue(": ping\n\n"), 15_000);
        this.clients.add(send);
        drop = () => {
          clearInterval(ping);
          this.clients.delete(send);
        };
      },
      cancel: () => drop(),
    });
    return new Response(stream.pipeThrough(new TextEncoderStream()), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }

  broadcast(message: { type: "reload" } | { type: "error"; message: string }) {
    for (const send of this.clients) send(`data: ${JSON.stringify(message)}\n\n`);
  }
}

/**
 * Calls `onChange` with the files that changed in app/, the generated API types and public/, after they settle.
 * Changes run one at a time. Returns a function that stops watching.
 */
export function watchApp(root: string, onChange: (files: string[]) => Promise<void>): () => void {
  const dirs = ["app", join("forge", "_generated"), "public"].map((d) => join(root, d)).filter(existsSync);
  const changed = new Set<string>();
  let timer: Timer | undefined;
  let running = Promise.resolve();
  const watchers = dirs.map((dir) =>
    watch(dir, { recursive: true }, (_event, file) => {
      if (!file || /(^|[\\/])(node_modules|\.)/.test(file)) return;
      changed.add(join(dir, file));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...changed];
        changed.clear();
        running = running.then(() => onChange(files)).catch(() => {});
      }, 60);
    }),
  );
  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
