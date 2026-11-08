// Checks that a server implements the benchmark's API (README.md) before it is measured: bun conformance.ts http://127.0.0.1:3000 [/prefix]
const [base = "http://127.0.0.1:3000", prefix = ""] = process.argv.slice(2);
const url = (path: string) => `${base}${prefix}${path}`;
let failed = 0;

async function check(name: string, req: Promise<Response>, status: number, body?: unknown) {
  try {
    const res = await req;
    const text = await res.text();
    const problems: string[] = [];
    if (res.status !== status) problems.push(`status ${res.status}, wanted ${status}`);
    if (body !== undefined) {
      let got: unknown;
      try {
        got = JSON.parse(text);
      } catch {
        got = text;
      }
      const ok = typeof body === "function" ? (body as (x: unknown) => boolean)(got) : JSON.stringify(got) === JSON.stringify(body);
      if (!ok) problems.push(`body ${text.slice(0, 120)}`);
      if (status !== 204 && !(res.headers.get("content-type") ?? "").includes("application/json")) problems.push(`content-type ${res.headers.get("content-type")}`);
    }
    if (status === 204 && text !== "") problems.push("a 204 with a body");
    console.log(`${problems.length ? "✗" : "✓"} ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
    if (problems.length) failed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e}`);
    failed++;
  }
}

const send = (method: string, path: string, body?: string) => fetch(url(path), { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body });
const good = JSON.stringify({ name: "widget", quantity: 7 });
const NOT_FOUND = { error: "not found" };
const INVALID = { error: "invalid item" };

await check("read a seeded item", send("GET", "/items/1"), 200, { id: 1, name: "item-1", quantity: 1 });
await check("read an item that is not there", send("GET", "/items/99999999"), 404, NOT_FOUND);
await check("read with an id that is not a number", send("GET", "/items/abc"), 404, NOT_FOUND);
await check("list: 20 by default", send("GET", "/items"), 200, (x) => Array.isArray(x) && x.length === 20 && x[0].id === 1 && x[19].id === 20);
await check("list with a limit", send("GET", "/items?limit=3"), 200, (x) => Array.isArray(x) && x.map((i: { id: number }) => i.id).join() === "1,2,3");
await check("list with a limit out of range is 20", send("GET", "/items?limit=500"), 200, (x) => Array.isArray(x) && x.length === 20);
await check("create", send("POST", "/items", good), 201, (x) => (x as { id: number }).id >= 1001 && (x as { name: string }).name === "widget" && (x as { quantity: number }).quantity === 7);
for (const [what, bad] of [
  ["without a name", '{"quantity":1}'],
  ["with an empty name", '{"name":"","quantity":1}'],
  ["with a negative quantity", '{"name":"a","quantity":-1}'],
  ["with a fractional quantity", '{"name":"a","quantity":1.5}'],
  ["with a quantity that is text", '{"name":"a","quantity":"1"}'],
  ["that is not JSON", "{nope"],
  ["that is an array", "[1]"],
] as const)
  // a body that is not JSON is refused by each framework's own parser, with its own message: the status is what is checked
  await check(`create ${what} is refused`, send("POST", "/items", bad), 400, what === "that is not JSON" ? undefined : INVALID);
await check("update", send("PUT", "/items/2", JSON.stringify({ name: "renamed", quantity: 9 })), 200, { id: 2, name: "renamed", quantity: 9 });
await check("the update is kept", send("GET", "/items/2"), 200, { id: 2, name: "renamed", quantity: 9 });
await check("update an item that is not there", send("PUT", "/items/99999999", good), 404, NOT_FOUND);
await check("update with a bad body", send("PUT", "/items/2", '{"name":1}'), 400, INVALID);
await check("delete", send("DELETE", "/items/3"), 204);
await check("delete again", send("DELETE", "/items/3"), 404, NOT_FOUND);
await check("the deleted item is gone", send("GET", "/items/3"), 404, NOT_FOUND);
await check("an unknown path", send("GET", "/nothing"), 404);
process.exit(failed ? 1 : 0);
