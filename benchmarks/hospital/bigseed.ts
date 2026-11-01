// Seeds a hospital-sized dataset through the app's own functions: 500 nurses, 250 physicians, 3000 patients,
// 500 active admissions with 48 h of charting each. API_URL must point at an EMPTY engine (never the dev one).
const { call, post, signIn, signUpAdmin } = await import(`${process.env.MEDICO_DIR ?? "../archlast-medico"}/apps/medico/scripts/client`);

const ADMIN_KEY = process.env.ADMIN_KEY!;
const NURSES = 500, DOCTORS = 250, PATIENTS = 3000, ADMITTED = 500;
const HOUR = 3_600_000;
const UNITS = ["CCU", "ICU", "MICU", "SICU", "NICU", "ER", "WARD", "PRIVATE"];
const between = (a: number, b: number) => Math.round(a + Math.random() * (b - a));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<unknown>) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; await fn(items[i]!, i); } }));
}
const t0 = Date.now();
const lap = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${m}`);

await signUpAdmin("Admin Reyes", "admin@medico.local", "medico1234", ADMIN_KEY);
const admin = await signIn("admin@medico.local", "medico1234");

const staff = [
  ...Array.from({ length: NURSES }, (_, i) => ({ role: "nurse", email: `nurse${i}@medico.local`, name: `Nurse Number${i}`, title: "RN" })),
  ...Array.from({ length: DOCTORS }, (_, i) => ({ role: "physician", email: `doc${i}@medico.local`, name: `Dr. Doctor Number${i}`, title: "MD" })),
];
await pool(staff, 8, (s) => post(admin, "/staff", { ...s, password: "medico1234" }));
lap(`${staff.length} staff created`);

const firsts = ["Maria", "Jose", "Ana", "Juan", "Luz", "Pedro", "Rosa", "Carlos", "Elena", "Miguel"];
const lasts = ["Santos", "Reyes", "Cruz", "Bautista", "Garcia", "Mendoza", "Torres", "Flores", "Ramos", "Aquino", "Villanueva", "Castillo"];
const ids: string[] = new Array(PATIENTS);
await pool(Array.from({ length: PATIENTS }), 32, async (_, i) => {
  const p = await call<{ _id: string }>(admin, "patients:create", {
    lastName: `${pick(lasts)}${i}`, firstName: pick(firsts), birthDate: Date.UTC(between(1935, 2015), between(0, 11), between(1, 28)), sex: pick(["MALE", "FEMALE"]),
  });
  ids[i] = p._id;
});
lap(`${PATIENTS} patients created`);

const doctors = await call<{ _id: string }[]>(admin, "staff:physicians", {});
const now = Date.now();
const admissions: { id: string; admittedAt: number }[] = [];
await pool(Array.from({ length: ADMITTED }), 16, async (_, i) => {
  const unit = UNITS[i % UNITS.length]!;
  const admittedAt = now - 48 * HOUR - between(0, 5) * HOUR;
  const a = await call<{ _id: string }>(admin, "admissions:create", {
    patientId: ids[i], unit, room: `${unit} ${Math.floor(i / UNITS.length) + 1}`, attendingPhysicianId: pick(doctors)._id, admittedAt,
    diagnosis: "Load test admission", chiefComplaint: "Shortness of breath",
  });
  admissions.push({ id: a._id, admittedAt });
});
lap(`${ADMITTED} admissions created`);

const nurseCookies = await Promise.all(Array.from({ length: 20 }, (_, i) => signIn(`nurse${i}@medico.local`, "medico1234")));
let rows = 0, fluids = 0;
await pool(admissions, 32, async (a) => {
  const c = pick(nurseCookies);
  for (let h = 48; h >= 1; h -= 2) { // 24 rows over 48 h, each with an oral intake; plus 12 urine outputs
    const at = now - h * HOUR;
    if (at < a.admittedAt) continue;
    await call(c, "monitoring:create", {
      admissionId: a.id, recordedAt: at, cardiacRate: between(60, 110), respiratoryRate: between(12, 24), systolic: between(100, 140), diastolic: between(60, 90), o2Sat: between(93, 100),
      fluids: [{ category: "ORAL", volumeMl: between(100, 300) }],
    });
    rows++;
    if (h % 4 === 0) { await call(c, "fluids:create", { admissionId: a.id, recordedAt: at + 600_000, category: "URINE", volumeMl: between(100, 400) }); fluids++; }
  }
});
lap(`${rows} monitoring rows, ${rows} + ${fluids} fluid entries`);
