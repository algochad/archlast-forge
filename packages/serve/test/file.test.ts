import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, file, type BackendName, type Server } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "archlast-file-"));
const BIG = 3 * 1024 * 1024;
const bigBytes = new Uint8Array(BIG).map((_, i) => (i * 31 + (i >> 8)) & 255);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(async () => {
    await Bun.write(join(dir, "big.bin"), bigBytes);
    await Bun.write(join(dir, "hello.txt"), "hello file");
    await Bun.write(join(dir, "data.json"), '{"a":1}');
    await Bun.write(join(dir, "page.html"), "<b>hi</b>");
    await Bun.write(join(dir, "noext"), "x");
    await Bun.write(join(dir, "empty.txt"), "");
    await Bun.write(join(dir, "huge.bin"), new Uint8Array(64 * 1024 * 1024).fill(7));
});

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`file responses: ${backend}`, () => {
        let s: Server;
        let base = "";
        beforeAll(() => {
            s = new App()
                .get("/f/:name", (c) => file(join(dir, c.params.name)))
                .get("/norange/:name", (c) => file(join(dir, c.params.name), { range: false }))
                .get("/custom", () => file(join(dir, "hello.txt"), { headers: { "x-custom": "1", "cache-control": "no-store" }, contentType: "text/x-test" }))
                .get("/set", (c) => { c.set.headers["x-extra"] = "yes"; return file(join(dir, "hello.txt")); })
                .get("/bad", () => file(join(dir, "does-not-exist")))
                .get("/dir", () => file(dir))
                .listen({ port: 0, backend });
            base = `http://127.0.0.1:${s.port}`;
        });
        afterAll(() => s.stop());

        test("GET streams the exact bytes with length, validators and range support advertised", async () => {
            const r = await fetch(`${base}/f/big.bin`);
            expect([r.status, r.headers.get("content-length"), r.headers.get("accept-ranges"), r.headers.get("content-type")]).toEqual([200, String(BIG), "bytes", "application/octet-stream"]);
            expect(r.headers.get("etag")).toMatch(/^W\//);
            expect(r.headers.get("last-modified")).toBeTruthy();
            const got = new Uint8Array(await r.arrayBuffer());
            expect(got.length).toBe(BIG);
            expect(Bun.hash(got)).toBe(Bun.hash(bigBytes));
        });

        test("content type comes from the extension (text gets a charset)", async () => {
            const type = async (n: string) => (await fetch(`${base}/f/${n}`)).headers.get("content-type");
            expect(await type("hello.txt")).toBe("text/plain;charset=utf-8");
            expect(await type("page.html")).toBe("text/html;charset=utf-8");
            expect(await type("data.json")).toBe("application/json;charset=utf-8");
            expect(await type("noext")).toBe("application/octet-stream");
        });

        test("HEAD returns the headers and length but no body", async () => {
            const r = await fetch(`${base}/f/big.bin`, { method: "HEAD" });
            expect([r.status, r.headers.get("content-length")]).toEqual([200, String(BIG)]);
            expect((await r.arrayBuffer()).byteLength).toBe(0);
        });

        test("Range: closed, open-ended, suffix, single byte", async () => {
            const part = async (range: string) => {
                const r = await fetch(`${base}/f/big.bin`, { headers: { range } });
                return { status: r.status, cr: r.headers.get("content-range"), cl: r.headers.get("content-length"), body: new Uint8Array(await r.arrayBuffer()) };
            };
            let p = await part("bytes=10-19");
            expect([p.status, p.cr, p.cl]).toEqual([206, `bytes 10-19/${BIG}`, "10"]);
            expect(Array.from(p.body)).toEqual(Array.from(bigBytes.subarray(10, 20)));
            p = await part(`bytes=${BIG - 4}-`);
            expect([p.status, p.cr]).toEqual([206, `bytes ${BIG - 4}-${BIG - 1}/${BIG}`]);
            expect(Array.from(p.body)).toEqual(Array.from(bigBytes.subarray(BIG - 4)));
            p = await part("bytes=-5");
            expect(Array.from(p.body)).toEqual(Array.from(bigBytes.subarray(BIG - 5)));
            p = await part("bytes=0-0");
            expect([p.status, p.cl, p.body[0]]).toEqual([206, "1", bigBytes[0]]);
            p = await part(`bytes=${BIG - 10}-${BIG * 5}`); // end past the file is clamped
            expect([p.status, p.cr]).toEqual([206, `bytes ${BIG - 10}-${BIG - 1}/${BIG}`]);
            p = await part("bytes=1048576-2097151"); // a range crossing many chunks
            expect(Bun.hash(p.body)).toBe(Bun.hash(bigBytes.subarray(1048576, 2097152)));
        });

        test("unsatisfiable ranges give 416; ranges we don't understand are ignored", async () => {
            let r = await fetch(`${base}/f/big.bin`, { headers: { range: `bytes=${BIG}-` } });
            expect([r.status, r.headers.get("content-range")]).toEqual([416, `bytes */${BIG}`]);
            r = await fetch(`${base}/f/big.bin`, { headers: { range: "bytes=-0" } });
            expect(r.status).toBe(416);
            for (const odd of ["items=0-5", "bytes=0-5,10-15", "bytes=abc", "bytes=5-2"]) {
                r = await fetch(`${base}/f/big.bin`, { headers: { range: odd } });
                expect([odd, r.status, r.headers.get("content-length")]).toEqual([odd, 200, String(BIG)]);
                await r.arrayBuffer();
            }
        });

        test("validators: If-None-Match and If-Modified-Since give 304; a stale If-Range gets the whole file", async () => {
            const first = await fetch(`${base}/f/hello.txt`);
            const etag = first.headers.get("etag")!;
            const lm = first.headers.get("last-modified")!;
            await first.text();
            let r = await fetch(`${base}/f/hello.txt`, { headers: { "if-none-match": etag } });
            expect([r.status, (await r.text()).length]).toEqual([304, 0]);
            r = await fetch(`${base}/f/hello.txt`, { headers: { "if-none-match": '"other"' } });
            expect([r.status, await r.text()]).toEqual([200, "hello file"]);
            r = await fetch(`${base}/f/hello.txt`, { headers: { "if-modified-since": lm } });
            expect(r.status).toBe(304);
            r = await fetch(`${base}/f/hello.txt`, { headers: { range: "bytes=0-1", "if-range": '"stale"' } });
            expect([r.status, await r.text()]).toEqual([200, "hello file"]);
        });

        test("range:false ignores Range; custom headers/type and ctx.set are applied; empty file is fine", async () => {
            let r = await fetch(`${base}/norange/big.bin`, { headers: { range: "bytes=0-9" } });
            expect([r.status, r.headers.get("content-length"), r.headers.get("accept-ranges")]).toEqual([200, String(BIG), null]);
            await r.arrayBuffer();
            r = await fetch(`${base}/custom`);
            expect([r.headers.get("x-custom"), r.headers.get("cache-control"), r.headers.get("content-type"), await r.text()]).toEqual(["1", "no-store", "text/x-test", "hello file"]);
            r = await fetch(`${base}/set`);
            expect([r.headers.get("x-extra"), await r.text()]).toEqual(["yes", "hello file"]);
            r = await fetch(`${base}/f/empty.txt`);
            expect([r.status, r.headers.get("content-length"), await r.text()]).toEqual([200, "0", ""]);
        });

        test("missing files and directories give 404 and the server keeps working", async () => {
            for (const p of ["/bad", "/dir", "/f/nope.txt"]) {
                const r = await fetch(`${base}${p}`);
                expect([p, r.status, await r.text()]).toEqual([p, 404, "Not Found"]);
            }
            expect(await (await fetch(`${base}/f/hello.txt`)).text()).toBe("hello file");
        });

        test("a 64 MiB file streams to the end, and concurrent downloads do not interfere", async () => {
            const read = async () => {
                const r = await fetch(`${base}/f/huge.bin`);
                let n = 0;
                const reader = r.body!.getReader();
                for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
                return n;
            };
            expect(await read()).toBe(64 * 1024 * 1024);
            const all = await Promise.all([read(), read(), read()]);
            expect(all).toEqual([64 * 1024 * 1024, 64 * 1024 * 1024, 64 * 1024 * 1024]);
        });
    });
}
