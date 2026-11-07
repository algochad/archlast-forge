import { expect, test } from "bun:test";

// A child process starts a server, then blocks its JS thread. A truly native static route must still answer.
const child = `
import { App } from ${JSON.stringify(import.meta.dir + "/../src/index.ts")};
const s = new App().get("/static", "from-rust").get("/dynamic", () => "from-js")
  .listen({ port: 0, backend: process.env.B, threads: 2 });
console.log("PORT " + s.port);
await Bun.sleep(100);
const end = Date.now() + 4000;
while (Date.now() < end) {}   // JS thread is busy: only Rust can answer now
process.exit(0);
`;

for (const backend of ["bun-ffi", "napi"]) {
  test(`static routes are answered while the JS thread is blocked (${backend})`, async () => {
    const proc = Bun.spawn(["bun", "-e", child], {
      env: { ...process.env, B: backend },
      stdout: "pipe",
    });
    const reader = proc.stdout.getReader();
    let out = "";
    while (!out.includes("\n"))
      out += new TextDecoder().decode((await reader.read()).value);
    const port = Number(out.trim().split(" ")[1]);
    await Bun.sleep(300); // child is now spinning

    const t0 = performance.now();
    const stat = await fetch(`http://127.0.0.1:${port}/static`);
    const statMs = performance.now() - t0;
    expect(await stat.text()).toBe("from-rust");
    expect(statMs).toBeLessThan(500);

    const dyn = await Promise.race([
      fetch(`http://127.0.0.1:${port}/dynamic`).then(() => "answered"),
      Bun.sleep(1000).then(() => "blocked"),
    ]);
    expect(dyn).toBe("blocked");
    proc.kill();
  });
}
