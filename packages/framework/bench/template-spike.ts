// Spike: the same 100-row page printed by React (renderToString) and by a Rust template, on the same engine, to see what the renderer is worth in isolation.
//   MODE=react|rust bun packages/framework/bench/template-spike.ts
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Reply, TemplateReply } from "../../serve/src/index.ts";
import { serveCompat } from "../../serve/src/compat.ts";
import { registerTemplate, renderTemplate } from "../../serve/src/templates.ts";

const WORDS = ["Anvil", "Bolt", "Cable", "Drill", "Engine", "Filter", "Gasket", "Hinge", "Insert", "Joint"];
const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `${WORDS[i % 10]} ${WORDS[(i * 7) % 10]} ${i + 1}`, sku: `SKU-${String(i + 1).padStart(5, "0")}`, stock: (i * 37) % 500, price: `$${(1.99 + ((i * 7919) % 250000) / 100).toFixed(2)}`, added: `Jan ${(i % 28) + 1}, 2026` }));

function Page({ data }: { data: { rows: typeof rows } }) {
  return h("main", null, h("h1", null, "Products"), h("table", null, h("thead", null, h("tr", null, ...["SKU", "Name", "Price", "Stock", "Added"].map((c) => h("th", { key: c }, c)))), h("tbody", null, data.rows.map((p) => h("tr", { key: p.id }, h("td", null, p.sku), h("td", null, p.name), h("td", null, p.price), h("td", null, p.stock), h("td", null, p.added))))));
}

const id = registerTemplate("products", [
  "<main><h1>Products</h1><table><thead><tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock</th><th>Added</th></tr></thead><tbody>",
  ["map", ["p", "d", "rows"], "p", null, ["<tr><td>", ["x", ["p", "p", "sku"]], "</td><td>", ["x", ["p", "p", "name"]], "</td><td>", ["x", ["p", "p", "price"]], "</td><td>", ["x", ["p", "p", "stock"]], "</td><td>", ["x", ["p", "p", "added"]], "</td></tr>"]],
  "</tbody></table></main>",
]);

const mode = process.env.MODE ?? "react";
const react = () => renderToString(h(Page, { data: { rows } }));
const json = JSON.stringify({ rows }); // what a query already is when it reaches the server: JSON text
const rust = () => renderTemplate(id, process.env.MODE === "rust-json" ? json : { rows });
if (process.env.CHECK) {
  const norm = (s: string) => s.replaceAll("<!-- -->", "");
  console.log("same output:", norm(react()) === rust(), react().length, rust().length);
  process.exit(0);
}
serveCompat({ port: 3600, fetch: () => mode === "io" ? (new TemplateReply(id, json, { headers: { "content-type": "text/html; charset=utf-8" } }) as unknown as Response) : new Reply(mode === "react" ? react() : mode === "static" ? json : rust(), { headers: { "content-type": "text/html; charset=utf-8" } }) as unknown as Response });
console.log("ready");
