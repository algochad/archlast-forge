// One of several Workers sharing a database file through the Turso adapter.
import { createTursoDb } from "../src/server/db/turso";
import { isRetryableConflict } from "../src/server/db/types";

declare var self: Worker;
self.onmessage = async (e: MessageEvent<{ path: string; id: number; rows: number; hot: boolean }>) => {
  const { path, id, rows, hot } = e.data;
  const db = await createTursoDb(path);
  let committed = 0;
  let conflicts = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows; i++) {
    for (;;) {
      try {
        await db.transaction("write", async (tx) => {
          if (hot) await tx.execute(`UPDATE "counter" SET "n" = "n" + 1 WHERE "id" = 1`);
          else await tx.execute(`INSERT INTO "rows" ("worker", "n") VALUES (?, ?)`, [id, i]);
        });
        committed++;
        break;
      } catch (err) {
        if (!isRetryableConflict(err)) {
          errors.push(String((err as Error).message));
          break;
        }
        conflicts++; // the executor's retry loop does this in the server
      }
    }
  }
  await db.close();
  postMessage({ committed, conflicts, errors });
};
