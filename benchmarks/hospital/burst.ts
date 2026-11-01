// burst.ts <fn> <n> [argsJson]: N different signed-in users call one function at the same moment; prints when each answer arrived.
const BASE = process.env.API_URL ?? "http://localhost:3100";
const fn = process.argv[2] ?? "admissions:census", N = Number(process.argv[3] ?? 200), args = process.argv[4] ?? "{}";
const signIn = async (email: string) => (await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: "medico1234" }) })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const cookies: string[] = [];
for (let i = 0; i < N; i += 25) cookies.push(...(await Promise.all(Array.from({ length: Math.min(25, N - i) }, (_, k) => signIn(`nurse${i + k}@medico.local`)))));
const t0 = performance.now(); const done: number[] = []; let errs = 0; const kinds = new Map<string, number>();
await Promise.all(cookies.map(async (cookie) => {
  const r = await fetch(`${BASE}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: args });
  const t = await r.text(); if (!r.ok) { errs++; const m = (JSON.parse(t).error?.message ?? t).slice(0, 50); kinds.set(m, (kinds.get(m) ?? 0) + 1); } done.push(performance.now() - t0);
}));
done.sort((a, b) => a - b); const q = (p: number) => done[Math.min(done.length - 1, Math.floor(done.length * p))]!.toFixed(0);
console.log(`${fn} x${N} distinct users, ${errs} errors: first ${done[0]!.toFixed(0)} ms · p10 ${q(0.1)} · p50 ${q(0.5)} · p90 ${q(0.9)} · last ${done.at(-1)!.toFixed(0)} ms  (spread of the answers ${(done.at(-1)! - done[0]!).toFixed(0)} ms)`);
for (const [m, n] of kinds) console.log("  error x" + n + ": " + m);
