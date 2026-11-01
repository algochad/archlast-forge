// Hospital-shaped load: N signed-in staff, each with a live WebSocket subscription to the sidebar's ward list,
// clicking around (census, a patient's chart, patient search, patient list) and charting now and then.
// Usage: VARIANT=before|after bun hospital.ts [clients=300] [seconds=60] [thinkMs=3000] [writeShare=0.08]
import { ArchlastForgeClient } from "../../packages/client/src/index";
import { anyApi } from "../../packages/runtime/src/index";
import { readFileSync } from "node:fs";

const BASE = process.env.API_URL ?? "http://localhost:3100";
const VARIANT = process.env.VARIANT ?? "before";
const CLIENTS = Number(process.argv[2] ?? 300), SECONDS = Number(process.argv[3] ?? 60), THINK = Number(process.argv[4] ?? 3000), WRITES = Number(process.argv[5] ?? 0.08);
const api: any = anyApi;
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const between = (a: number, b: number) => Math.round(a + Math.random() * (b - a));
const sidebarFn = VARIANT === "after" ? api.admissions.beds : api.admissions.census;

// SPREAD_IPS=1: each user signs in from an address of their own (the engine must run with TRUST_PROXY=1), as 300 staff on one network would not be one client to Better Auth's sign-in limit.
let nextIp = 0;
const ipHeader = (): Record<string, string> => (process.env.SPREAD_IPS ? { "x-forwarded-for": `10.9.${(nextIp >> 8) & 255}.${nextIp++ & 255}` } : {});
async function signIn(email: string) {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...ipHeader() }, body: JSON.stringify({ email, password: "medico1234" }) });
  if (!r.ok) throw new Error(`sign-in ${email}: ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
const serverCpu = () => { // CPU seconds used by the engine and its children (the process listening on BASE's port)
  const port = new URL(BASE).port;
  const ps = Bun.spawnSync(["ps", "-eo", "pid,ppid,cputimes,args"]).stdout.toString().trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/, 3).concat(l.trim().split(/\s+/).slice(3).join(" ")));
  const main = ps.find((p) => p[3]!.includes("archlast-forge") && p[3]!.includes(`--port ${port}`));
  if (!main) return 0;
  const ids = new Set([main[0]]); let grew = true;
  while (grew) { grew = false; for (const p of ps) if (ids.has(p[1]!) && !ids.has(p[0]!)) { ids.add(p[0]!); grew = true; } }
  let ticks = 0;
  for (const id of ids) try { const f = readFileSync(`/proc/${id}/stat`, "utf8").split(") ")[1]!.split(" "); ticks += Number(f[11]) + Number(f[12]); } catch {}
  return ticks / 100;
};

const staff = Array.from({ length: CLIENTS }, (_, i) => (i % 3 === 2 ? `doc${Math.floor(i / 3) % 250}` : `nurse${(i - Math.floor(i / 3)) % 500}`) + "@medico.local");
const cookies: string[] = [];
for (let i = 0; i < staff.length; i += 25) cookies.push(...(await Promise.all(staff.slice(i, i + 25).map(signIn))));

const rpc = async (cookie: string, name: string, args: object) => { const r = await fetch(`${BASE}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(args) }); const b: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error?.message ?? b.message ?? String(r.status)); return b.result; };
const beds: any[] = await rpc(cookies[0]!, "admissions:census", {});
const admissionIds: string[] = beds.map((b) => b._id);
const patientIds: string[] = beds.map((b) => b.patient._id);
const units = [...new Set(beds.map((b) => b.unit as string))];
console.log(`${VARIANT} · ${BASE} · ${CLIENTS} clients · ${SECONDS}s · think ${THINK}ms · ${(WRITES * 100).toFixed(0)}% writes · ${admissionIds.length} admissions`);

const lat = new Map<string, number[]>(); const errs = new Map<string, number>();
const rec = (op: string, ms: number) => { (lat.get(op) ?? lat.set(op, []).get(op)!).push(ms); };
let pushes = 0, windowReq = 0, windowErr = 0, total = 0;
const end = Date.now() + SECONDS * 1000;

async function user(i: number) {
  const cookie = cookies[i]!;
  const client = new ArchlastForgeClient({ url: BASE, WebSocket: class extends WebSocket { constructor(u: any, p?: any) { super(u, { headers: { cookie, origin: BASE } } as any); } } as any });
  const timed = async (op: string, fn: () => Promise<unknown>) => {
    const t = performance.now();
    try { await fn(); } catch (e) { windowErr++; const m = op + ": " + (e as Error).message.slice(0, 60); errs.set(m, (errs.get(m) ?? 0) + 1); }
    rec(op, performance.now() - t); windowReq++; total++;
  };
  const stops: (() => void)[] = [];
  const sub = (ref: any, args: object, op: string) => { // time to first value, then count the live pushes; an error update is an error, not a value
    const t = performance.now(); let first = true;
    return client.watch(ref, args, (u: any) => {
      if (u && "error" in u) { windowErr++; const m = op + ": " + String(u.error?.message ?? u.error).slice(0, 60); errs.set(m, (errs.get(m) ?? 0) + 1); if (first) { first = false; windowReq++; total++; } return; }
      if (first) { rec(op, performance.now() - t); first = false; windowReq++; total++; } else pushes++;
    });
  };
  const watch = (ref: any, args: object, op: string) => void stops.push(sub(ref, args, op));
  await Bun.sleep(Math.random() * Number(process.env.STAGGER ?? 0)); // staff do not all sign in the same second
  watch(sidebarFn, {}, "sidebar (live)");
  const adm = () => pick(admissionIds);
  let leave: (() => void)[] = [];
  let current = adm();
  await Bun.sleep(Math.random() * THINK);
  while (Date.now() < end) {
    const r = Math.random();
    leave.forEach((f) => f()); leave = [];
    if (r < WRITES) { // chart on the open patient
      const at = Date.now() - between(0, 300_000);
      await timed(Math.random() < 0.6 ? "write monitoring:create" : "write fluids:create", () => Math.random() < 0.6
        ? rpc(cookie, "monitoring:create", { admissionId: current, recordedAt: at, cardiacRate: between(60, 110), systolic: between(100, 140), diastolic: between(60, 90), o2Sat: between(93, 100) })
        : rpc(cookie, "fluids:create", { admissionId: current, recordedAt: at, category: "ORAL", volumeMl: between(50, 250) }));
    } else if (r < 0.40) { // census page (live)
      leave.push(sub(api.admissions.census, VARIANT === "after" ? { unit: pick(units) } : {}, "census page (live)"));
    } else if (r < 0.75) { // open a patient's chart: admission + the monitoring sheet (24 h) + I&O sheet
      current = adm();
      const since = Math.floor(Date.now() / 60_000) * 60_000 - 24 * 3_600_000;
      for (const [ref, args, op] of [[api.admissions.get, { id: current }, "chart: admission"], [api.monitoring.list, { admissionId: current, from: since }, "chart: monitoring"], [api.fluids.sheet, { admissionId: current }, "chart: I&O sheet"]] as const) {
        leave.push(sub(ref, args, op));
      }
    } else if (r < 0.88) { // search box (debounced, one request per pause)
      await timed("patient search", () => rpc(cookie, "patients:list", { search: pick(["a", "san", "cruz", "reyes", "mar", "MRN-2026-0001"]), pageSize: 8 }));
    } else { // patients page
      await timed("patients list p" + (Math.random() < 0.7 ? "1" : "n"), () => rpc(cookie, "patients:list", { page: Math.random() < 0.7 ? 1 : between(2, 100), pageSize: 20 }));
    }
    await Bun.sleep(-Math.log(1 - Math.random()) * THINK);
  }
  leave.forEach((f) => f()); stops.forEach((f) => f()); client.close();
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0; };
const cpu0 = serverCpu(), started = Date.now(); let cpuLast = cpu0, pushLast = 0;
const tick = setInterval(() => {
  const c = serverCpu();
  console.log(`t=${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s  ${String(windowReq).padStart(5)} req/s  live pushes ${String(pushes - pushLast).padStart(6)}/s  server cpu ${(c - cpuLast).toFixed(1)} cores  errors ${windowErr}`);
  windowReq = 0; windowErr = 0; cpuLast = c; pushLast = pushes;
}, 1000);
await Promise.all(Array.from({ length: CLIENTS }, (_, i) => user(i)));
clearInterval(tick);
const secs = (Date.now() - started) / 1000, cores = (serverCpu() - cpu0) / secs;
console.log(`\n${total} requests = ${(total / secs).toFixed(0)}/s · ${(pushes / secs).toFixed(0)} live pushes/s · server used ${cores.toFixed(2)} cores avg · ${[...errs.values()].reduce((a, b) => a + b, 0)} errors`);
for (const [op, xs] of [...lat].sort()) console.log(`${op.padEnd(22)} n=${String(xs.length).padStart(6)}  p50 ${pct(xs, 0.5).toFixed(0).padStart(5)}ms  p95 ${pct(xs, 0.95).toFixed(0).padStart(5)}ms  p99 ${pct(xs, 0.99).toFixed(0).padStart(5)}ms`);
for (const [m, n] of errs) console.log(`error x${n}: ${m}`);
process.exit(0);
