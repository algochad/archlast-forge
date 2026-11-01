// Load test: N clients hammer the running app through its own functions (/rpc), ~90% reads, ~10% writes.
// Usage: bun loadtest.ts [clients=100] [seconds=60] [writeShare=0.1]
const { call, signIn } = await import(`${process.env.MEDICO_DIR ?? "../archlast-medico"}/apps/medico/scripts/client`);

const CLIENTS = Number(process.argv[2] ?? 100);
const SECONDS = Number(process.argv[3] ?? 60);
const WRITE_SHARE = Number(process.argv[4] ?? 0.1);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const between = (a: number, b: number) => Math.round(a + Math.random() * (b - a));

const cookies = await Promise.all(["nurse0", "nurse1", "nurse2", "nurse3"].map((u) => signIn(`${u}@medico.local`, "medico1234")));
const nurses = cookies.slice(0, 3);

const census = await call<{ _id: string; patient: { _id: string } }[]>(cookies[0]!, "admissions:census", {});
const admissions = census.map((a) => a._id);
const patientIds = [...new Set(census.map((a) => a.patient._id))];
if (!admissions.length) throw new Error("No active admissions: run `bun run db:seed` first");
const patients = await Promise.all(patientIds.map((id) => call<any>(cookies[0]!, "patients:get", { id })));
console.log(`target ${process.env.API_URL ?? "http://localhost:3000"} · ${CLIENTS} clients · ${SECONDS}s · ${admissions.length} admissions · ${patients.length} patients · ${(WRITE_SHARE * 100).toFixed(0)}% writes`);

type Op = { name: string; weight: number; run: (cookie: string) => Promise<unknown> };
const ops: Op[] = [
  { name: "admissions:census", weight: process.env.NO_CENSUS ? 0 : 30, run: (c) => call(c, "admissions:census", {}) },
  { name: "admissions:get", weight: 15, run: (c) => call(c, "admissions:get", { id: pick(admissions) }) },
  { name: "monitoring:list", weight: 20, run: (c) => call(c, "monitoring:list", { admissionId: pick(admissions), from: Date.now() - 24 * 3_600_000 }) },
  { name: "fluids:sheet", weight: 10, run: (c) => call(c, "fluids:sheet", { admissionId: pick(admissions) }) },
  { name: "patients:list", weight: 10, run: (c) => call(c, "patients:list", { search: pick(["", "a", "cruz", "tan"]) }) },
  { name: "patients:get", weight: 5, run: (c) => call(c, "patients:get", { id: pick(patientIds) }) },
  { name: "monitoring:create", weight: WRITE_SHARE * 100 * 0.5, run: (c) => call(c, "monitoring:create", {
    admissionId: pick(admissions), recordedAt: Date.now() - between(0, 600_000),
    cardiacRate: between(60, 110), respiratoryRate: between(12, 24), systolic: between(100, 140), diastolic: between(60, 90), o2Sat: between(93, 100), remarks: "load test",
  }) },
  { name: "fluids:create", weight: WRITE_SHARE * 100 * 0.35, run: (c) => call(c, "fluids:create", {
    admissionId: pick(admissions), recordedAt: Date.now() - between(0, 600_000), category: pick(["ORAL", "VENOCLYSIS", "URINE"]), volumeMl: between(20, 300),
  }) },
  { name: "patients:update", weight: WRITE_SHARE * 100 * 0.15, run: (c) => {
    const p = pick(patients);
    return call(c, "patients:update", { id: p._id, lastName: p.lastName, firstName: p.firstName, middleName: p.middleName, birthDate: p.birthDate, sex: p.sex, allergies: p.allergies, bloodType: p.bloodType, address: `Ward round ${between(1, 999)}` });
  } },
];
const total = ops.reduce((s, o) => s + o.weight, 0);
const draw = () => { let r = Math.random() * total; for (const o of ops) if ((r -= o.weight) < 0) return o; return ops[0]!; };

const stats = new Map(ops.map((o) => [o.name, { n: 0, err: 0, ms: [] as number[] }]));
let window: number[] = [], windowN = 0, windowErr = 0, all = 0, allErr = 0;
const firstErrors = new Map<string, number>();
const end = Date.now() + SECONDS * 1000;

async function client(i: number) {
  const cookie = nurses[i % nurses.length]!;
  while (Date.now() < end) {
    const op = draw(), s = stats.get(op.name)!, t = performance.now();
    try { await op.run(cookie); } catch (e) {
      s.err++; windowErr++; allErr++;
      const m = (e as Error).message.slice(0, 80); firstErrors.set(m, (firstErrors.get(m) ?? 0) + 1);
    }
    const ms = performance.now() - t;
    s.n++; s.ms.push(ms); window.push(ms); windowN++; all++;
  }
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
const started = Date.now();
const ticker = setInterval(() => {
  console.log(`t=${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s  ${String(windowN).padStart(6)} req/s  p50 ${pct(window, 0.5).toFixed(1)}ms  p99 ${pct(window, 0.99).toFixed(1)}ms  errors ${windowErr}`);
  window = []; windowN = 0; windowErr = 0;
}, 1000);

await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
clearInterval(ticker);

const secs = (Date.now() - started) / 1000;
console.log(`\n${all} requests in ${secs.toFixed(1)}s = ${(all / secs).toFixed(0)} req/s avg · ${allErr} errors`);
for (const [name, s] of stats) console.log(`${name.padEnd(20)} ${String(s.n).padStart(8)}  p50 ${pct(s.ms, 0.5).toFixed(1).padStart(7)}ms  p99 ${pct(s.ms, 0.99).toFixed(1).padStart(8)}ms  err ${s.err}`);
for (const [m, n] of firstErrors) console.log(`error x${n}: ${m}`);
