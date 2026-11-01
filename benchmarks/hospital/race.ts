const BASE = "http://localhost:3100";
const cookieOf = async (email: string) => (await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: "medico1234" }) })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const rpc = async (cookie: string, name: string, args: object) => { const r = await fetch(`${BASE}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(args) }); const b: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error?.message ?? b.message ?? String(r.status)); return b.result; };
const cookies = await Promise.all(Array.from({ length: 30 }, (_, i) => cookieOf(`nurse${i}@medico.local`)));
const doc = (await rpc(cookies[0]!, "staff:physicians", {}))[0]._id;
const page = await rpc(cookies[0]!, "patients:list", { page: 5, pageSize: 100 }); // patients far from the admitted ones
const free = page.items.filter((p: any) => p.admissions.length === 0).map((p: any) => p._id);
const at = Date.now() - 3_600_000;
const tally = (rs: PromiseSettledResult<unknown>[]) => `${rs.filter((r) => r.status === "fulfilled").length} succeeded, ${rs.filter((r) => r.status === "rejected").length} refused`;

// 1. thirty different patients race for one bed
const bed = await Promise.allSettled(free.slice(0, 30).map((id: string, i: number) => rpc(cookies[i]!, "admissions:create", { patientId: id, unit: "CCU", room: "RACE BED 1", attendingPhysicianId: doc, admittedAt: at })));
console.log("one bed, 30 patients:    ", tally(bed), "(expect 1 succeeded)");
// 2. one patient raced into thirty different beds
const patient = free[40];
const pat = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => rpc(cookies[i]!, "admissions:create", { patientId: patient, unit: "WARD", room: `RACE ROOM ${i}`, attendingPhysicianId: doc, admittedAt: at })));
console.log("one patient, 30 beds:    ", tally(pat), "(expect 1 succeeded)");
// 3. the same client id saved thirty times at once must make one row
const adm = (bed.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>).value._id;
const id = crypto.randomUUID();
const dup = await Promise.allSettled(Array.from({ length: 30 }, () => rpc(cookies[0]!, "fluids:create", { id, admissionId: adm, recordedAt: at + 60_000, category: "ORAL", volumeMl: 100 })));
const rows = (await rpc(cookies[0]!, "fluids:list", { admissionId: adm })).length;
console.log("same save id, 30 times:  ", tally(dup), `-> ${rows} fluid row(s) stored (expect 1)`);
