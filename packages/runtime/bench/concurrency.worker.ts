// One Worker writing to the shared database file; reports commits and every distinct error it saw.
import { Database } from "bun:sqlite";

declare var self: Worker;
type Driver = "turso" | "bun-busy" | "bun-nobusy";

self.onmessage = async (e: MessageEvent<{ driver: Driver; path: string; id: number; rows: number; hot: boolean }>) => {
  const { driver, path, id, rows, hot } = e.data;
  const errors: Record<string, number> = {};
  let committed = 0;
  let retries = 0;
  const note = (err: unknown) => {
    const k = String((err as Error)?.message ?? err).replace(/\d+/g, "N").slice(0, 80);
    errors[k] = (errors[k] ?? 0) + 1;
  };
  const sql = hot ? `UPDATE t SET n = n + 1 WHERE id = 1` : `INSERT INTO t (w, n) VALUES (?, ?)`;
  const args = (i: number) => (hot ? [] : [id, i]);
  try {
    if (driver === "turso") {
      const { connect } = await import("@tursodatabase/database");
      const db = await connect(path);
      await (await db.prepare("PRAGMA busy_timeout = 5000")).run();
      const stmt = await db.prepare(sql);
      for (let i = 0; i < rows; i++) {
        for (let attempt = 0; ; attempt++) {
          try {
            await db.exec("BEGIN CONCURRENT");
            await stmt.run(...args(i));
            await db.exec("COMMIT");
            committed++;
            break;
          } catch (err) {
            if (db.inTransaction) await db.exec("ROLLBACK").catch(() => {});
            if (!/conflict|dependency aborted/i.test(String((err as Error).message)) || attempt >= 9) {
              note(err); // the server's executor gives up after the same 10 attempts
              break;
            }
            retries++;
            await Bun.sleep(Math.random() * 2 ** (attempt + 1) * 5); // the executor's jittered backoff
          }
        }
      }
      await db.close();
    } else {
      const db = new Database(path);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = ${driver === "bun-busy" ? 5000 : 0}`);
      const stmt = db.query(sql);
      for (let i = 0; i < rows; i++) {
        try {
          db.exec("BEGIN IMMEDIATE");
          stmt.run(...args(i));
          db.exec("COMMIT");
          committed++;
        } catch (err) {
          if (db.inTransaction) db.exec("ROLLBACK");
          note(err);
        }
      }
      db.close();
    }
  } catch (err) {
    note(err);
  }
  postMessage({ committed, retries, errors });
};
