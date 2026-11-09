// bun assets.ts <base url> <path>: the page's size and what the browser must download to show it: HTML, scripts, stylesheets (bytes and gzip).
import { gzipSync } from "node:zlib";

const [base, path] = process.argv.slice(2);
const html = await fetch(base + path, { headers: { "accept-encoding": "identity" } }).then((r) => r.text());
const urls = new Set<string>();
for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) urls.add(m[1]!);
for (const m of html.matchAll(/<link[^>]*rel="(?:modulepreload|stylesheet)"[^>]*href="([^"]+)"/g)) urls.add(m[1]!);
for (const m of html.matchAll(/<link[^>]*href="([^"]+)"[^>]*rel="(?:modulepreload|stylesheet)"/g)) urls.add(m[1]!);
let js = 0, css = 0, jsGz = 0, cssGz = 0, files = 0;
for (const u of urls) {
  const body = new Uint8Array(await fetch(new URL(u, base).href, { headers: { "accept-encoding": "identity" } }).then((r) => r.arrayBuffer()));
  const gz = gzipSync(body, { level: 9 }).length;
  files++;
  if (/\.css(\?|$)/.test(u)) (css += body.length), (cssGz += gz);
  else (js += body.length), (jsGz += gz);
}
console.log(JSON.stringify({ htmlBytes: html.length, htmlGzip: gzipSync(html).length, files, jsKB: +(js / 1024).toFixed(1), jsGzKB: +(jsGz / 1024).toFixed(1), cssGzKB: +(cssGz / 1024).toFixed(1) }));
