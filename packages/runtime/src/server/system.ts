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
    `CREATE TABLE IF NOT EXISTS "_logs" ("_id" TEXT PRIMARY KEY, "time" ${real} NOT NULL, "server" TEXT NOT NULL, "name" TEXT NOT NULL, "level" TEXT NOT NULL, "message" TEXT NOT NULL, "durationMs" ${real}, "ok" ${name === "postgres" ? "BOOLEAN" : "INTEGER"}, "requestId" TEXT)`,
    `CREATE INDEX IF NOT EXISTS "afx_logs_time" ON "_logs" ("time")`,
    `CREATE INDEX IF NOT EXISTS "afx_logs_name_time" ON "_logs" ("name", "time")`,
    `CREATE TABLE IF NOT EXISTS "_metrics" ("time" ${real} NOT NULL, "server" TEXT NOT NULL, "subscriptions" INTEGER NOT NULL, "connections" INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS "afx_metrics_time" ON "_metrics" ("time")`,
    `CREATE TABLE IF NOT EXISTS "_env" ("name" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" ${real} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT PRIMARY KEY, "state" TEXT NOT NULL, "cursor" TEXT, "processed" INTEGER NOT NULL, "error" TEXT, "updatedAt" ${real} NOT NULL)`,
  ];
  await db.transaction("write", async (tx) => {
    if (name === "postgres") await tx.execute("SELECT pg_advisory_xact_lock(727276)");
    for (const sql of statements) await tx.execute(sql);
  });
}

export const SYSTEM_TABLES = ["_scheduled_functions", "_admins", "_admin_sessions", "_audit", "_logs", "_metrics", "_env", "_migrations", "_search_indexes"];
