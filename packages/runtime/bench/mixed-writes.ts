// Readers, small writers (read then insert) and a log-flush-like transaction of many inserts, all in one process on one database.
// Without the adapter's one-writer-at-a-time queue, `logrows` of 600 beside 50 writers froze the thread for good on the 2.5M-row benchmark database.
//   bun bench/mixed-writes.ts <database> [writers=50] [readers=200] [seconds=40] [tx|plain readers=tx] [logrows=600]
// The database needs the benchmark's tables (posts, likes, _logs); seed one with benchmarks/twelve-dollar/seed.ts.
import { createTursoDb } from "../src/server/db/turso";
import { isRetryableConflict } from "../src/server/db/types";
const WRITERS = Number(process.argv[3] ?? 50), READERS = Number(process.argv[4] ?? 200), SECS = Number(process.argv[5] ?? 40);
const db = await createTursoDb(process.argv[2]!);
const stats = { reads: 0, writes: 0, conflicts: 0, errors: 0, slow: 0, inflightWrites: 0, inflightReads: 0 };
const errs = new Map<string, number>();
const end = Date.now() + SECS * 1000;
const hex = (n: number) => n.toString(16).padStart(32, "0");
const withTimeout = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("HANG " + what)), 10_000))]);
const TX = process.argv[6] !== "plain";
async function read() {
  if (TX) return db.transaction("read", async (tx) => {
    const rows = await tx.query<{ _id: string }>(`SELECT "_id", "_creationTime", "doc" FROM "posts" ORDER BY "_creationTime" DESC, "_id" DESC LIMIT 20`);
    for (const r of rows) await tx.query(`SELECT COUNT(*) AS n FROM "likes" WHERE json_extract("doc", '$.postId') = ?`, [r._id]);
  });
  const rows = await db.query<{ _id: string }>(`SELECT "_id", "_creationTime", "doc" FROM "posts" ORDER BY "_creationTime" DESC, "_id" DESC LIMIT 20`);
  for (const r of rows) await db.query(`SELECT COUNT(*) AS n FROM "likes" WHERE json_extract("doc", '$.postId') = ?`, [r._id]);
}
let seq = 0;
async function write(uid: number) {
  const post = `posts:${hex(1 + Math.floor(Math.random() * 500000))}`;
  const user = `users:${hex(uid)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction("write", async (tx) => {
        const have = await tx.query(`SELECT "_id" FROM "likes" WHERE json_extract("doc", '$.userId') = ? AND json_extract("doc", '$.postId') = ? LIMIT 1`, [user, post]);
        if (!have.length) await tx.execute(`INSERT INTO "likes" ("_id", "_creationTime", "doc") VALUES (?, ?, ?)`, [`likes:${crypto.randomUUID().replaceAll("-", "")}`, Date.now(), JSON.stringify({ userId: user, postId: post })]);
      });
      return;
    } catch (e) {
      if (isRetryableConflict(e) && attempt < 9) { stats.conflicts++; await Bun.sleep(Math.random() * 2 ** attempt * 5); continue; }
      throw e;
    }
  }
}
async function loop(kind: "r" | "w", id: number) {
  while (Date.now() < end) {
    try {
      if (kind === "r") { stats.inflightReads++; await withTimeout(read(), "read"); stats.reads++; stats.inflightReads--; }
      else { stats.inflightWrites++; await withTimeout(write(id + 1), "write"); stats.writes++; stats.inflightWrites--; }
    } catch (e) {
      if (kind === "r") stats.inflightReads--; else stats.inflightWrites--;
      const m = String((e as Error).message).slice(0, 80); errs.set(m, (errs.get(m) ?? 0) + 1); stats.errors++;
      if (m.startsWith("HANG")) { console.log("HANG detected", JSON.stringify(stats)); return; }
    }
    await Bun.sleep(kind === "r" ? 100 + Math.random() * 300 : 200 + Math.random() * 600);
  }
}
const LOGROWS = Number(process.argv[7] ?? 600);
async function logger() {
  while (Date.now() < end) {
    const t = performance.now();
    try {
      await withTimeout(db.transaction("write", async (tx) => {
        for (let i = 0; i < LOGROWS; i += 100) {
          const n = Math.min(100, LOGROWS - i);
          await tx.execute(`INSERT INTO "_logs" ("_id", "time", "server", "name", "level", "message", "durationMs", "ok", "requestId") VALUES ${Array(n).fill("(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
            Array.from({ length: n }).flatMap(() => [`_logs:${crypto.randomUUID()}`, Date.now(), "s", "feed:list", "call", "", 3.2, 1, "req"]));
        }
      }), "logflush");
    } catch (e) { console.log("logger error", String((e as Error).message).slice(0, 100)); if (String((e as Error).message).startsWith("HANG")) return; }
    const ms = performance.now() - t;
    if (ms > 1000) console.log("slow flush", ms.toFixed(0), "ms");
    await Bun.sleep(1000);
  }
}
const t0 = Date.now();
const ticker = setInterval(() => console.log(`t=${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(stats), `rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`), 5000);
await Promise.all([...(LOGROWS ? [logger()] : []), ...Array.from({ length: WRITERS }, (_, i) => loop("w", i)), ...Array.from({ length: READERS }, (_, i) => loop("r", i))]);
clearInterval(ticker);
console.log("done", JSON.stringify(stats), [...errs]);
process.exit(0);
