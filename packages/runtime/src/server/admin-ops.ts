// Admin operations, run inside the function runtime (which owns the database). The server checks roles first.
import type { CronJob, FunctionKind, RegisteredFunction, UserIdentity } from "../functions";
import { ValidationError } from "../values";
import type { Db } from "./db/types";
import type { Executor, LogEntry } from "./executor";
import { cancelScheduled, nextRun, retryScheduled } from "./scheduler";
import type { Storage } from "./storage";

export type AdminRole = "owner" | "admin" | "viewer";
export const ROLES: AdminRole[] = ["owner", "admin", "viewer"];
/** Admin-key access acts as this owner account. */
export const KEY_ADMIN = { id: "admin-key", email: "admin-key", role: "owner" as AdminRole };

const SESSION_TTL_MS = 12 * 3600_000;
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const newId = (table: string) => `${table}:${crypto.randomUUID().replaceAll("-", "")}`;

// ---- admin accounts (the CLI calls these in-process) ----

export async function addAdmin(db: Db, email: string, password: string, role: AdminRole) {
  if (!ROLES.includes(role)) throw new ValidationError(`Role must be one of ${ROLES.join(", ")}`);
  if (password.length < 12) throw new ValidationError("Admin passwords must be at least 12 characters");
  const hash = await Bun.password.hash(password);
  await db.execute(
    `INSERT INTO "_admins" ("_id", "email", "passwordHash", "role", "createdAt") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("email") DO UPDATE SET "passwordHash" = excluded."passwordHash", "role" = excluded."role"`,
    [newId("_admins"), email.toLowerCase(), hash, role, Date.now()],
  );
}

export const listAdmins = (db: Db) => db.query<{ email: string; role: AdminRole; createdAt: number }>(`SELECT "email", "role", "createdAt" FROM "_admins" ORDER BY "email"`);

export async function removeAdmin(db: Db, email: string) {
  const [admin] = await db.query<{ _id: string }>(`SELECT "_id" FROM "_admins" WHERE "email" = ?`, [email.toLowerCase()]);
  if (!admin) throw new ValidationError(`No admin ${email}`);
  await db.execute(`DELETE FROM "_admin_sessions" WHERE "adminId" = ?`, [admin._id]);
  await db.execute(`DELETE FROM "_admins" WHERE "_id" = ?`, [admin._id]);
}

async function createSession(db: Db, adminId: string) {
  const token = randomToken();
  await db.execute(`INSERT INTO "_admin_sessions" ("_id", "adminId", "expiresAt") VALUES (?, ?, ?)`, [sha256(token), adminId, Date.now() + SESSION_TTL_MS]);
  await db.execute(`DELETE FROM "_admin_sessions" WHERE "expiresAt" < ?`, [Date.now()]);
  return token;
}

export interface AdminInfo {
  email: string;
  role: AdminRole;
}

// ---- operations ----

export interface AdminDeps {
  db: Db;
  exec: Executor;
  functions: Map<string, RegisteredFunction>;
  crons: CronJob[];
  storage?: Storage;
  /** Clears Better Auth's own session cache, if any. */
  serverId: string;
}

const WRITE_OPS = new Set(["insertDoc", "patchDoc", "replaceDoc", "deleteDoc", "cancelJob", "retryJob", "deleteFile", "revokeSession", "banUser", "run"]);

export async function adminOp(d: AdminDeps, op: string, args: any, actor: string): Promise<unknown> {
  const { db, exec } = d;
  const result = await (async () => {
    switch (op) {
      // -- admin sessions --
      case "login": {
        const [a] = await db.query<{ _id: string; email: string; role: AdminRole; passwordHash: string }>(`SELECT * FROM "_admins" WHERE "email" = ?`, [
          String(args.email ?? "").toLowerCase(),
        ]);
        // Verify against a dummy hash when the account doesn't exist, so timing doesn't reveal emails.
        const ok = await Bun.password.verify(String(args.password ?? ""), a?.passwordHash ?? "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").catch(() => false);
        if (!a || !ok) throw new ValidationError("Invalid email or password");
        return { token: await createSession(db, a._id), admin: { email: a.email, role: a.role } };
      }
      case "keySession":
        return { token: await createSession(db, KEY_ADMIN.id), admin: { email: KEY_ADMIN.email, role: KEY_ADMIN.role } };
      case "session": {
        const [s] = await db.query<{ adminId: string }>(`SELECT "adminId" FROM "_admin_sessions" WHERE "_id" = ? AND "expiresAt" > ?`, [sha256(String(args.token)), Date.now()]);
        if (!s) return null;
        if (s.adminId === KEY_ADMIN.id) return { email: KEY_ADMIN.email, role: KEY_ADMIN.role };
        const [a] = await db.query<AdminInfo>(`SELECT "email", "role" FROM "_admins" WHERE "_id" = ?`, [s.adminId]);
        return a ?? null;
      }
      case "logout":
        await db.execute(`DELETE FROM "_admin_sessions" WHERE "_id" = ?`, [sha256(String(args.token))]);
        return null;
      case "audit":
        return db.query(`SELECT * FROM "_audit" ORDER BY "time" DESC LIMIT ?`, [Math.min(Number(args.limit) || 200, 1000)]);

      // -- data --
      case "docs":
        return (
          await exec.read(async (s) => {
            let q: any = s.query(args.table);
            if (args.index) q = q.withIndex(args.index, (b: any) => (args.eq ?? []).reduce((acc: any, [f, v]: [string, unknown]) => acc.eq(f, v), b));
            return q.order(args.order ?? "desc").paginate({ numItems: Math.min(Number(args.numItems) || 50, 500), cursor: args.cursor ?? null });
          })
        ).value;
      case "counts":
        return Object.fromEntries(
          await Promise.all(
            (args.tables as string[]).map(async (t) => [t, Number((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "${assertTable(d, t)}"`))[0]?.n ?? 0)]),
          ),
        );
      case "insertDoc":
        return exec.mutate((s) => s.insert(args.table, args.value));
      case "patchDoc":
        return exec.mutate((s) => s.patch(args.id, args.value));
      case "replaceDoc":
        return exec.mutate((s) => s.replace(args.id, args.value));
      case "deleteDoc":
        return exec.mutate((s, _tx, after) => (String(args.id).startsWith("_storage:") ? exec.storage(s, after).delete(args.id) : s.delete(args.id)));

      // -- functions --
      case "run": {
        const identity = args.asUserId ? await identityOf(exec, args.asUserId) : null;
        return (await exec.call(args.name, args.kind as FunctionKind, args.args, identity, args.requestId)).value;
      }

      // -- scheduler --
      case "scheduled": {
        const where = args.state ? `WHERE "state" = ?` : "";
        return db.query(`SELECT * FROM "_scheduled_functions" ${where} ORDER BY "scheduledTime" DESC LIMIT ?`, [
          ...(args.state ? [args.state] : []),
          Math.min(Number(args.limit) || 200, 1000),
        ]);
      }
      case "crons":
        return d.crons.map((c) => ({ ...c, next: nextRun(c.schedule, Date.now()) }));
      case "cancelJob":
        return exec.mutate((_s, tx) => cancelScheduled(tx, args.id));
      case "retryJob":
        return exec.mutate((_s, tx) => retryScheduled(tx, args.id));

      // -- files --
      case "files": {
        const page = (await exec.read((s) => s.query("_storage").order("desc").paginate({ numItems: Math.min(Number(args.numItems) || 50, 200), cursor: args.cursor ?? null }))).value;
        const storage = d.storage;
        return {
          ...page,
          page: await Promise.all(
            page.page.map(async (f: any) => ({
              ...f,
              size: storage ? await storage.stat(f.key).then((s) => s.size).catch(() => null) : null,
              url: storage?.getPresignedUrl(f.key, { expiresIn: 600 }) ?? null,
            })),
          ),
        };
      }
      case "deleteFile":
        return exec.mutate((s, _tx, after) => exec.storage(s, after).delete(args.id));

      // -- auth users --
      case "users":
        return (
          await exec.read(async (s) => {
            const q = args.email ? s.query("users").withIndex("by_email", (b: any) => b.eq("email", args.email)) : s.query("users");
            return q.order("desc").paginate({ numItems: Math.min(Number(args.numItems) || 50, 200), cursor: args.cursor ?? null });
          })
        ).value;
      case "sessions":
        return (await exec.read((s) => s.query("sessions").withIndex("by_userId", (b: any) => b.eq("userId", args.userId)).collect())).value.map(
          ({ token, ...rest }: any) => rest, // tokens never leave the server
        );
      case "revokeSession":
        return exec.mutate((s) => s.delete(args.id));
      case "banUser":
        return exec.mutate(async (s) => {
          await s.patch(args.userId, { banned: Boolean(args.banned) });
          if (args.banned) for (const session of await s.query("sessions").withIndex("by_userId", (b: any) => b.eq("userId", args.userId)).collect()) await s.delete(session._id);
        });

      // -- logs and metrics --
      case "logs": {
        const conds: string[] = [];
        const params: unknown[] = [];
        if (args.since) conds.push(`"time" >= ?`), params.push(Number(args.since));
        if (args.until) conds.push(`"time" <= ?`), params.push(Number(args.until));
        if (args.name) conds.push(`"name" = ?`), params.push(String(args.name));
        if (args.level) conds.push(`"level" = ?`), params.push(String(args.level));
        if (args.requestId) conds.push(`"requestId" = ?`), params.push(String(args.requestId));
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        return db.query(`SELECT * FROM "_logs" ${where} ORDER BY "time" DESC LIMIT ?`, [...params, Math.min(Number(args.limit) || 200, 2000)]);
      }
      case "metrics":
        return metrics(db, Number(args.windowMs) || 3600_000, Number(args.buckets) || 30);
      case "recordMetric":
        await db.execute(`INSERT INTO "_metrics" ("time", "server", "subscriptions", "connections") VALUES (?, ?, ?, ?)`, [
          Date.now(),
          String(args.server),
          Number(args.subscriptions),
          Number(args.connections),
        ]);
        await db.execute(`DELETE FROM "_metrics" WHERE "time" < ?`, [Date.now() - 30 * 86400_000]);
        return null;

      // -- environment variables (values stay server-side) --
      case "env":
        return db.query(`SELECT "name", "updatedAt" FROM "_env" ORDER BY "name"`);
    }
    throw new ValidationError(`Unknown admin operation "${op}"`);
  })();
  if (WRITE_OPS.has(op)) {
    const target = args.id ?? args.table ?? args.name ?? args.userId ?? null;
    const details = JSON.stringify({ ...args, requestId: undefined }).slice(0, 2000);
    await db.execute(`INSERT INTO "_audit" ("_id", "time", "actor", "action", "target", "details") VALUES (?, ?, ?, ?, ?, ?)`, [
      newId("_audit"),
      Date.now(),
      actor,
      op,
      target,
      details,
    ]);
  }
  return result;
}

function assertTable(d: AdminDeps, table: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw new ValidationError(`Invalid table "${table}"`);
  return table;
}

/** Acting as a user from the dashboard: their identity without a session. */
async function identityOf(exec: Executor, userId: string): Promise<UserIdentity> {
  const user = (await exec.read((s) => s.get(userId))).value;
  if (!user) throw new ValidationError(`No user ${userId}`);
  return { userId: user._id as UserIdentity["userId"], sessionId: "dashboard", email: user.email, name: user.name };
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);

async function metrics(db: Db, windowMs: number, buckets: number) {
  const now = Date.now();
  const since = now - windowMs;
  const size = windowMs / buckets;
  const calls = await db.query<{ time: number; durationMs: number; ok: unknown }>(
    `SELECT "time", "durationMs", "ok" FROM "_logs" WHERE "level" = 'call' AND "time" >= ? ORDER BY "time" DESC LIMIT 200000`,
    [since],
  );
  const samples = await db.query<{ time: number; server: string; subscriptions: number; connections: number }>(
    `SELECT * FROM "_metrics" WHERE "time" >= ? ORDER BY "time"`,
    [since],
  );
  return Array.from({ length: buckets }, (_, i) => {
    const start = since + i * size;
    const end = start + size;
    const inBucket = calls.filter((c) => c.time >= start && c.time < end);
    const durations = inBucket.map((c) => c.durationMs ?? 0).sort((a, b) => a - b);
    // Latest sample per server in this bucket, summed across servers.
    const latest = new Map<string, { subscriptions: number; connections: number }>();
    for (const s of samples) if (s.time >= start && s.time < end) latest.set(s.server, s);
    const sum = (k: "subscriptions" | "connections") => (latest.size ? [...latest.values()].reduce((n, s) => n + Number(s[k]), 0) : null);
    return {
      start,
      calls: inBucket.length,
      errors: inBucket.filter((c) => !c.ok).length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      subscriptions: sum("subscriptions"),
      connections: sum("connections"),
    };
  });
}

/** Buffers log entries and writes them in batches; trims entries older than the retention. */
export class LogWriter {
  private buffer: (LogEntry & { server: string })[] = [];
  private timer: Timer;
  private lastTrim = 0;

  constructor(
    private db: Db,
    private server: string,
    private retentionMs: number,
  ) {
    this.timer = setInterval(() => void this.flush().catch((e) => console.error("log flush failed:", e)), 1000);
  }

  push(entry: LogEntry) {
    this.buffer.push({ ...entry, server: this.server });
    if (this.buffer.length > 10_000) this.buffer.splice(0, this.buffer.length - 10_000); // never grow without bound
  }

  async flush() {
    const rows = this.buffer.splice(0);
    if (rows.length)
      await this.db.transaction("write", async (tx) => {
        for (const r of rows)
          await tx.execute(
            `INSERT INTO "_logs" ("_id", "time", "server", "name", "level", "message", "durationMs", "ok", "requestId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId("_logs"), r.time, r.server, r.name, r.level, r.message.slice(0, 4000), r.durationMs ?? null, r.ok === undefined ? null : r.ok, r.requestId ?? null],
          );
      });
    if (Date.now() - this.lastTrim > 3600_000) {
      this.lastTrim = Date.now();
      await this.db.execute(`DELETE FROM "_logs" WHERE "time" < ?`, [Date.now() - this.retentionMs]);
    }
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
