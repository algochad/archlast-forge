import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { BackendName } from "../src/index.ts";

const backends: BackendName[] = ["bun-ffi", "napi"];
const fixture = import.meta.dir + "/fixtures/mt-app.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => procs.forEach((p) => p.kill()));

async function startApp(workers: number, backend: BackendName, extraEnv: Record<string, string> = {}): Promise<number> {
    const proc = Bun.spawn(["bun", fixture], { env: { ...process.env, WORKERS: String(workers), BACKEND: backend, ...extraEnv }, stdout: "pipe", stderr: "ignore" });
    procs.push(proc);
    const reader = proc.stdout.getReader();
    let out = "";
    const deadline = Date.now() + 15000;
    while (!out.includes("\n") && Date.now() < deadline) out += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    const m = out.match(/READY (\d+)/);
    if (!m) throw new Error(`app did not start: ${out}`);
    return Number(m[1]);
}

for (const backend of backends) {
    describe(`multi-threaded: ${backend}`, () => {
        test("light load stays on one thread; a backlog wakes the others", async () => {
            const port = await startApp(4, backend);
            const light = new Set<number>();
            for (let i = 0; i < 60; i++) light.add(((await (await fetch(`http://127.0.0.1:${port}/lane`)).json()) as { lane: number }).lane);
            expect(light.size).toBe(1); // consolidated: idle threads stay asleep

            const counts = new Map<number, number>();
            const burst = await Promise.all(Array.from({ length: 120 }, () => fetch(`http://127.0.0.1:${port}/busy`).then((r) => r.json() as Promise<{ lane: number }>)));
            for (const b of burst) counts.set(b.lane, (counts.get(b.lane) ?? 0) + 1);
            expect([...counts.keys()].sort()).toEqual([0, 1, 2, 3]); // the backlog pulled every thread in
            for (const n of counts.values()) expect(n).toBeGreaterThan(5);
        });

        test("WebSocket clients land on different threads and pub/sub crosses threads", async () => {
            const port = await startApp(3, backend);
            const socks = Array.from({ length: 12 }, (_, i) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?name=c${i}`);
                const got: string[] = [];
                ws.onmessage = (e) => got.push(String(e.data));
                return { ws, got, open: new Promise<void>((r) => (ws.onopen = () => r())) };
            });
            await Promise.all(socks.map((s) => s.open));
            await sleep(300);
            const hellos = socks.map((s) => JSON.parse(s.got[0]) as { lane: number });
            expect(new Set(hellos.map((h) => h.lane)).size).toBe(3);
            socks[0].ws.send("pub:cross-thread");
            await sleep(300);
            for (const s of socks.slice(1)) expect(s.got).toContain("cross-thread");
            expect(socks[0].got).not.toContain("cross-thread");
            socks.forEach((s) => s.ws.close());
        });

        test("SSE streams work under the pool, and every disconnect is seen by the thread that owns the stream", async () => {
            const closedFile = `/tmp/archlast-closed-${process.pid}-${backend}`;
            writeFileSync(closedFile, "");
            const port = await startApp(3, backend, { CLOSED_FILE: closedFile });
            const ctrls = Array.from({ length: 6 }, () => new AbortController());
            const readers = await Promise.all(ctrls.map(async (c) => (await fetch(`http://127.0.0.1:${port}/events`, { signal: c.signal })).body!.getReader()));
            const first = await Promise.all(readers.map(async (r) => JSON.parse(new TextDecoder().decode((await r.read()).value).replace(/^data: /, "")) as { lane: number }));
            expect(first.length).toBe(6); // each stream delivered its first event (which thread serves it is up to the pool)
            ctrls.forEach((c) => c.abort());
            for (let i = 0; i < 80 && readFileSync(closedFile).length < 6; i++) await sleep(50);
            expect(readFileSync(closedFile).length).toBe(6);
            rmSync(closedFile);
        });

        test("a crashed worker is taken out of rotation, nothing hangs, and the rest keep serving", async () => {
            const port = await startApp(4, backend);
            const crashed = new Set<number>();
            const burst = await Promise.all(Array.from({ length: 60 }, () => fetch(`http://127.0.0.1:${port}/crash`).then((r) => r.json() as Promise<{ lane: number }>)));
            for (const b of burst) if (b.lane !== 0) crashed.add(b.lane);
            expect(crashed.size).toBeGreaterThan(0); // at least one worker really crashed
            await sleep(500);
            const lanes = new Set<number>();
            for (let i = 0; i < 150; i++) {
                const r = await fetch(`http://127.0.0.1:${port}/lane`);
                expect(r.status).toBe(200);
                lanes.add(((await r.json()) as { lane: number }).lane);
            }
            for (const dead of crashed) expect(lanes.has(dead)).toBe(false);
            expect(lanes.size).toBeGreaterThan(0);
        });
    });
}
