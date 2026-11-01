// Variables set with `archlast-forge env` or from the dashboard: the function runtime puts them in process.env (see loadEnv).
import { ValidationError } from "../values";
import type { Db } from "./db/types";

export const listEnv = (db: Db) => db.query<{ name: string; value: string; updatedAt: number }>(`SELECT * FROM "_env" ORDER BY "name"`);

export async function setEnv(db: Db, name: string, value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ValidationError(`Invalid variable name "${name}"`);
  await db.execute(`INSERT INTO "_env" ("name", "value", "updatedAt") VALUES (?, ?, ?) ON CONFLICT ("name") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"`, [
    name,
    value,
    Date.now(),
  ]);
}

export const removeEnv = (db: Db, name: string) => db.execute(`DELETE FROM "_env" WHERE "name" = ?`, [name]);
