import type { Db } from "./db/types";

/** System tables outside the document store. Every server runs this at startup; it's idempotent. */
export async function migrateSystem(db: Db) {
  const { realType: real, name } = db.dialect;
  const statements = [
    `CREATE TABLE IF NOT EXISTS "_scheduled_functions" ("_id" TEXT PRIMARY KEY, "_creationTime" ${real} NOT NULL, "name" TEXT NOT NULL, "args" TEXT NOT NULL, "scheduledTime" ${real} NOT NULL, "state" TEXT NOT NULL, "error" TEXT, "completedTime" ${real})`,
    `CREATE INDEX IF NOT EXISTS "afx_scheduled_due" ON "_scheduled_functions" ("state", "scheduledTime")`,
    `CREATE TABLE IF NOT EXISTS "_admins" ("_id" TEXT PRIMARY KEY, "email" TEXT NOT NULL UNIQUE, "passwordHash" TEXT NOT NULL, "role" TEXT NOT NULL, "createdAt" ${real} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS "_admin_sessions" ("_id" TEXT PRIMARY KEY, "adminId" TEXT NOT NULL, "expiresAt" ${real} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS "_audit" ("_id" TEXT PRIMARY KEY, "time" ${real} NOT NULL, "actor" TEXT NOT NULL, "action" TEXT NOT NULL, "target" TEXT, "details" TEXT)`,
    `CREATE INDEX IF NOT EXISTS "afx_audit_time" ON "_audit" ("time")`,
    `CREATE TABLE IF NOT EXISTS "_env" ("name" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" ${real} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT PRIMARY KEY, "state" TEXT NOT NULL, "cursor" TEXT, "processed" INTEGER NOT NULL, "error" TEXT, "updatedAt" ${real} NOT NULL)`,
  ];
  await db.transaction("write", async (tx) => {
    if (name === "postgres") await tx.execute("SELECT pg_advisory_xact_lock(727276)");
    for (const sql of statements) await tx.execute(sql);
  });
}

// _logs, _metrics and _cache_stats held function logs and samples before the telemetry store did; they are no longer written, and
// stay listed so a database from then keeps them out of the data browser. _otel_* are the telemetry store's tables on Postgres.
export const SYSTEM_TABLES = ["_scheduled_functions", "_admins", "_admin_sessions", "_audit", "_logs", "_metrics", "_cache_stats", "_env", "_migrations", "_search_indexes"];
