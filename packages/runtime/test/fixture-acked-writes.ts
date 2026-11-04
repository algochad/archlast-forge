// Writes rows as fast as 32 callers can and prints the id of each one the moment its write is answered. The test kills this process.
import { createSqliteDb } from "../src/server/db/sqlite";

const db = createSqliteDb(process.argv[2]!, 4, undefined, process.argv[3] === "NORMAL" ? "NORMAL" : "FULL");
await db.execute(`CREATE TABLE IF NOT EXISTS "t" ("k" INTEGER PRIMARY KEY, "v" TEXT)`);
let next = 0;
const caller = async () => {
  for (;;) {
    const k = next++;
    await db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES (?, ?)`, [k, "x".repeat(200)]));
    process.stdout.write(`${k}\n`); // after the answer: this id must survive
  }
};
await Promise.all(Array.from({ length: 32 }, caller));
