import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { apiDocs } from "../src/api-docs/host";

const forge = join(mkdtempSync(join(tmpdir(), "afx-api-docs-")), "forge");
mkdirSync(join(forge, "docs"), { recursive: true });
writeFileSync(join(forge, "docs", "02-webhooks.mdx"), "# Webhooks\n\nWe *sign* every webhook.\n");
writeFileSync(join(forge, "docs", "01-orders.mdx"), "# Ordering\n\nOrders are **final**.\n");
const ask = (path: string, headers: Record<string, string> = {}) =>
  apiDocs.serve(new Request(`http://localhost/_api${path}`, { headers: { "accept-encoding": "identity", ...headers } }), { base: "/_api", forgeDir: forge, dev: false });

test("the page: a shell, a minified bundle split per page, with the app's MDX pages in it", async () => {
  const page = await ask("");
  expect(page!.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const html = await page!.text();
  expect(html).toContain('data-base="/_api"');
  expect(html).toContain("/_api/fonts/geist.woff2");
  const script = /src="\/_api\/assets\/([^"]+\.js)"/.exec(html)![1]!;
  const js = await (await ask(`/assets/${script}`))!.text();
  expect(js).toContain("Calling this API"); // the guide, compiled from MDX into the entry
  expect(js.length / js.split("\n").length).toBeGreaterThan(2000); // minified: long lines
  // The app's pages, in file-name order, each in a chunk loaded when it is opened.
  expect(js.indexOf('"Ordering"')).toBeGreaterThan(-1);
  expect(js.indexOf('"Ordering"')).toBeLessThan(js.indexOf('"Webhooks"'));
  const chunk = /chunk-[a-z0-9]+\.js/.exec(js.slice(js.indexOf('"Ordering"')))![0];
  expect(await (await ask(`/assets/${chunk}`))!.text()).toContain("final");
  const asset = await ask(`/assets/${script}`, { "accept-encoding": "gzip, br" });
  expect(asset!.headers.get("content-encoding")).toBe("br");
  expect(asset!.headers.get("cache-control")).toContain("immutable");
  expect(await ask("/assets/nope.js")).toBeNull();
});

test("the explorer: Scalar, vendored and sent compressed, with nothing that calls Scalar's cloud", async () => {
  expect(await (await ask("/explorer"))!.text()).toContain('<script src="/_api/scalar.js"></script>');
  const config = await (await ask("/explorer.js"))!.text();
  expect(config).toContain('"showDeveloperTools":"never"');
  expect(config).toContain('"agent":{"disabled":true}');
  expect(config).toContain('"telemetry":false');
  const br = await ask("/scalar.js", { "accept-encoding": "br" });
  expect(br!.headers.get("content-encoding")).toBe("br");
  const plain = await ask("/scalar.js"); // a client without brotli gets it decompressed
  expect(plain!.headers.get("content-encoding")).toBeNull();
  const bytes = new Uint8Array(await plain!.arrayBuffer());
  expect(brotliDecompressSync(new Uint8Array(await br!.arrayBuffer())).length).toBe(bytes.length);
  expect(new TextDecoder().decode(bytes.slice(0, 200))).toContain("function");
  expect((await ask("/fonts/geist.woff2"))!.headers.get("content-type")).toBe("font/woff2");
});

test("the page's first load stays within its budget", async () => {
  const { gzip } = await apiDocs.firstLoadBytes("/_api", forge);
  console.log(`API docs page, first load: ${gzip} bytes gzipped (HTML, script, stylesheet; fonts are two Latin woff2 files, 29 and 23 KB)`);
  expect(gzip).toBeLessThan(90 * 1024);
});
