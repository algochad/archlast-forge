import { afterAll, describe, expect, test } from "bun:test";
import { defaultBackend } from "../src/backend.ts";
import { type CompatServer, serveCompat } from "../src/compat.ts";
import { TemplateReply } from "../src/server.ts";
import { registerTemplate, renderTemplate } from "../src/templates.ts";

const servers: CompatServer<any>[] = [];
afterAll(() => servers.forEach((s) => void s.stop(true)));

const page = registerTemplate("test-page", ["<ul>", ["map", ["p", "d", "items"], "i", null, ["<li", ["a", "class", ["p", "i", "cls"], false], ">", ["x", ["p", "i", "name"]], "</li>"]], "</ul>", ["if", ["p", "d", "note"], ["<p>", ["x", ["p", "d", "note"]], "</p>"], []]]);
const data = { items: [{ name: "a<b", cls: "x" }, { name: "c", cls: null }], note: "ok & done" };

describe("pages printed by the engine", () => {
  test("renderTemplate prints with JSON data, and the same template can be replaced", () => {
    expect(renderTemplate(page, data)).toBe('<ul><li class="x">a&lt;b</li><li>c</li></ul><p>ok &amp; done</p>');
    expect(renderTemplate(page, JSON.stringify({ items: [] }))).toBe("<ul></ul>");
    expect(() => registerTemplate("bad", [["nope"]])).toThrow(/unknown node/);
  });

  test("a TemplateReply is printed on the I/O thread with the status and headers it was given", async () => {
    const s = serveCompat({ port: 0, backend: defaultBackend(), fetch: () => new TemplateReply(page, JSON.stringify(data), { status: 201, headers: { "content-type": "text/html; charset=utf-8", "x-a": "1" } }) as unknown as Response });
    servers.push(s);
    const r = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("x-a")).toBe("1");
    expect(await r.text()).toBe('<ul><li class="x">a&lt;b</li><li>c</li></ul><p>ok &amp; done</p>');
  });

  test("data that is not valid JSON, or a template that is not there, is a 500, not a crash", async () => {
    let n = 0;
    const s = serveCompat({ port: 0, backend: defaultBackend(), fetch: () => new TemplateReply(n++ === 0 ? page : 99999, n === 1 ? "{not json" : "{}") as unknown as Response });
    servers.push(s);
    expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(500);
    expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(500);
    n = 100;
    expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(500); // and the server is still there
  });

  // Each binding has a registry of its own: the same tests, with the other one doing the work.
  if (!process.env.ARCHLAST_BACKEND)
    test("the same on the bun:ffi binding", async () => {
      const p = Bun.spawn([process.execPath, "test", import.meta.path], { env: { ...process.env, ARCHLAST_BACKEND: "bun-ffi", FORCE_COLOR: "" }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(await p.exited, out + err).toBe(0);
    });
});
