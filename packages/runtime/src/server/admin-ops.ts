// Admin operations, run inside the function runtime (which owns the database). The server checks roles first.
import type { CronJob, FunctionKind, RegisteredFunction, UserIdentity } from "../functions";
import { ValidationError } from "../values";
import type { Db } from "./db/types";
import { compileCustom, type CustomCodeError } from "./custom";
import type { ConsoleLine, Executor } from "./executor";
import { indexFor, relationsOf } from "../relations";
import { tableOf } from "../values";
import type { TablesSpec } from "./docstore";
import { cancelScheduled, nextRun, retryScheduled } from "./scheduler";
import type { Storage } from "./storage";
import type { Backups } from "./backup/backups";
import { removeEnv, setEnv } from "./env-store";

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

/** Credentials the dashboard never shows, by table: an admin has no need to read them, and a viewer is meant to be read-only. */
const SECRET_FIELDS: Record<string, string[]> = { accounts: ["password", "accessToken", "refreshToken", "idToken"], sessions: ["token"], verifications: ["value"] };
const HIDDEN = "[hidden]";

/** A document as the dashboard may see it. */
function redact<T extends { _id: string }>(doc: T): T {
  const fields = SECRET_FIELDS[tableOf(doc._id)];
  if (!fields) return doc;
  const out: Record<string, unknown> = { ...doc };
  for (const f of fields) if (out[f] !== undefined && out[f] !== null) out[f] = HIDDEN;
  return out as T;
}
const redactOrNull = (doc: { _id: string } | null | undefined) => (doc ? redact(doc) : null);
/** A file's link for the dashboard, or null for a row whose key storage refuses (one written before keys were checked). */
const urlOf = (storage: Storage | undefined, key: string) => {
  try {
    return storage?.getPresignedUrl(key, { expiresIn: 600 }) ?? null;
  } catch {
    return null;
  }
};
/** An edit that sends the placeholder back must not overwrite the real value. */
const withoutHidden = (value: any) => Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== HIDDEN));
const restoreHidden = (value: any, existing: any) =>
  Object.fromEntries(
    Object.entries(value ?? {})
      .map(([k, v]): [string, unknown] => [k, v === HIDDEN && existing ? existing[k] : v])
      .filter(([, v]) => v !== HIDDEN),
  );

export interface AdminInfo {
  email: string;
  role: AdminRole;
}

// ---- operations ----

export interface AdminDeps {
  db: Db;
  exec: Executor;
  functions: Map<string, RegisteredFunction>;
  tables: TablesSpec;
  crons: CronJob[];
  storage?: Storage;
  /** Clears Better Auth's own session cache, if any. */
  serverId: string;
  /** In the first function-runtime process only. */
  backups?: Backups;
}

const WRITE_OPS = new Set([
  "insertDoc",
  "patchDoc",
  "replaceDoc",
  "deleteDoc",
  "cancelJob",
  "retryJob",
  "deleteFile",
  "revokeSession",
  "banUser",
  "run",
  "runCustom",
  "clearCache",
  "backups.create",
  "backups.restore",
  "backups.delete",
  "backups.import",
  "settings.save",
  "env.set",
  "env.remove",
]);

const backupsOf = (d: AdminDeps) => {
  if (!d.backups) throw new Error("Backups run in the first function runtime process; this one is another");
  return d.backups;
};

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
        const ok = await Bun.password
          .verify(String(args.password ?? ""), a?.passwordHash ?? "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
          .catch(() => false);
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
      case "docs": {
        const page = (
          await exec.read(async (s) => {
            let q: any = s.query(args.table);
            if (args.index) q = q.withIndex(args.index, (b: any) => (args.eq ?? []).reduce((acc: any, [f, v]: [string, unknown]) => acc.eq(f, v), b));
            return q.order(args.order ?? "desc").paginate({ numItems: Math.min(Number(args.numItems) || 50, 500), cursor: args.cursor ?? null });
          })
        ).value;
        return { ...page, page: page.page.map(redact) };
      }
      // Many documents by id, for showing what a reference points at. Ids that aren't valid, or whose document is gone, come back null.
      case "docsByIds": {
        const ids = [...new Set((args.ids as unknown[]) ?? [])].filter((id): id is string => typeof id === "string").slice(0, 200);
        const known = ids.filter((id) => id.includes(":") && d.tables[tableOf(id)]);
        const docs = (await exec.read((s) => s.getMany(known))).value;
        const found = new Map(known.map((id, i) => [id, docs[i]]));
        return Object.fromEntries(ids.map((id) => [id, redactOrNull(found.get(id))]));
      }
      // What points at a document: for each field in the schema that references its table, how many documents hold its id.
      case "references": {
        const id = String(args.id);
        if (!id.includes(":") || !d.tables[tableOf(id)]) throw new ValidationError(`Invalid id ${JSON.stringify(id)}`);
        const target = tableOf(id);
        const pointing = relationsOf(d.tables).filter((r) => r.target === target);
        return Promise.all(
          pointing.map(async (r) => {
            const index = indexFor(d.tables[r.table]!, r.field);
            const count = await exec
              .read((s) => {
                const q: any = index
                  ? s.query(r.table).withIndex(index, (b: any) => b.eq(r.field, id))
                  : s.query(r.table).filter((doc) => (r.many ? (doc[r.field] ?? []).includes(id) : doc[r.field] === id));
                return q.count();
              })
              .then((x) => x.value as number)
              .catch(() => null); // too big to scan without an index
            return { table: r.table, field: r.field, many: r.many, index: index ?? null, count };
          }),
        );
      }
      case "counts":
        return Object.fromEntries(
          await Promise.all((args.tables as string[]).map(async (t) => [t, Number((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "${assertTable(d, t)}"`))[0]?.n ?? 0)])),
        );
      case "insertDoc":
        return exec.mutate((s) => s.insert(args.table, withoutHidden(args.value)));
      case "patchDoc":
        return exec.mutate((s) => s.patch(args.id, withoutHidden(args.value)));
      case "replaceDoc":
        return exec.mutate(async (s) => s.replace(args.id, restoreHidden(args.value, await s.get(args.id))));
      case "deleteDoc":
        return exec.mutate((s, _tx, after) => (String(args.id).startsWith("_storage:") ? exec.storage(s, after).delete(args.id) : s.delete(args.id)));

      // -- functions --
      case "run": {
        const identity = args.asUserId ? await identityOf(exec, args.asUserId) : null;
        return (await exec.call(args.name, args.kind as FunctionKind, args.args, identity, args.requestId)).value;
      }

      // Code written in the dashboard. The router only lets owners get here, and only when ALLOW_CUSTOM_FUNCTIONS is on.
      // Failures come back as data so the dashboard can show them next to the console output.
      case "runCustom": {
        const logs: ConsoleLine[] = [];
        const began = performance.now();
        const done = (r: object) => ({ ms: Math.round((performance.now() - began) * 10) / 10, logs, ...r });
        let fn: RegisteredFunction;
        try {
          fn = await compileCustom(String(args.code ?? ""));
        } catch (e) {
          return done({ ok: false, error: (e as Error).message, line: (e as CustomCodeError).line, phase: "compile" });
        }
        try {
          const identity = args.asUserId ? await identityOf(exec, args.asUserId) : null;
          const out = await exec.execute(fn, `custom:${fn.kind}`, args.args, identity, args.requestId, logs);
          return done({ ok: true, kind: fn.kind, value: out.value });
        } catch (e) {
          return done({ ok: false, kind: fn.kind, error: (e as Error).message, phase: "run" });
        }
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
        const page = (
          await exec.read((s) =>
            s
              .query("_storage")
              .order("desc")
              .paginate({ numItems: Math.min(Number(args.numItems) || 50, 200), cursor: args.cursor ?? null }),
          )
        ).value;
        const storage = d.storage;
        return {
          ...page,
          page: await Promise.all(
            page.page.map(async (f: any) => ({
              ...f,
              size: storage
                ? await storage
                    .stat(f.key)
                    .then((s) => s.size)
                    .catch(() => null)
                : null,
              url: urlOf(storage, f.key),
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
        return (
          await exec.read((s) =>
            s
              .query("sessions")
              .withIndex("by_userId", (b: any) => b.eq("userId", args.userId))
              .collect(),
          )
        ).value.map(
          ({ token, ...rest }: any) => rest, // tokens never leave the server
        );
      case "revokeSession":
        return exec.mutate((s) => s.delete(args.id));
      case "banUser":
        return exec.mutate(async (s) => {
          await s.patch(args.userId, { banned: Boolean(args.banned) });
          if (args.banned)
            for (const session of await s
              .query("sessions")
              .withIndex("by_userId", (b: any) => b.eq("userId", args.userId))
              .collect())
              await s.delete(session._id);
        });

      // A change made outside the runtime (the observability settings live in the telemetry store), recorded here with the rest.
      case "recordAudit":
        await db.execute(`INSERT INTO "_audit" ("_id", "time", "actor", "action", "target", "details") VALUES (?, ?, ?, ?, ?, ?)`, [
          newId("_audit"),
          Date.now(),
          actor,
          String(args.action),
          args.target ?? null,
          String(args.details ?? "{}"),
        ]);
        return null;
      // The cache lives in the server process, which has already emptied it; this records the action in the audit log.
      case "clearCache":
        return null;

      // -- environment variables (values stay server-side) --
      case "env":
        return db.query(`SELECT "name", "updatedAt" FROM "_env" ORDER BY "name"`);
      case "env.set":
        return setEnv(db, String(args.name ?? ""), String(args.value ?? ""));
      case "env.remove":
        return removeEnv(db, String(args.name ?? ""));

      // -- engine settings: the server checks and normalizes them, this stores them --
      case "settings.stored":
        return db.query(`SELECT "name", "value", "updatedAt", "updatedBy" FROM "_settings" ORDER BY "name"`);
      case "settings.save":
        if (args.value === null || args.value === undefined) return db.execute(`DELETE FROM "_settings" WHERE "name" = ?`, [String(args.name)]);
        return db.execute(
          `INSERT INTO "_settings" ("name", "value", "updatedAt", "updatedBy") VALUES (?, ?, ?, ?) ON CONFLICT ("name") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt", "updatedBy" = excluded."updatedBy"`,
          [String(args.name), String(args.value), Date.now(), actor],
        );

      // -- backups --
      case "backups.list":
        return backupsOf(d).list();
      case "backups.create":
        return (await backupsOf(d).start({ kind: "manual", files: args.files === undefined ? undefined : Boolean(args.files), actor })).row;
      case "backups.restore":
        return (await backupsOf(d).restore(String(args.id), { files: Boolean(args.files), config: Boolean(args.config), actor })).started;
      case "backups.delete":
        return backupsOf(d).remove(String(args.id));
      case "backups.download":
        return backupsOf(d).download(String(args.id));
      case "backups.import":
        return backupsOf(d).importFile(String(args.path), actor);
    }
    throw new ValidationError(`Unknown admin operation "${op}"`);
  })();
  if (WRITE_OPS.has(op)) {
    const target = args.id ?? args.table ?? args.name ?? args.userId ?? null;
    // Never a value: environment variables and settings can be secrets.
    const details = JSON.stringify({ ...args, requestId: undefined, value: undefined, path: undefined }).slice(0, 2000);
    await db.execute(`INSERT INTO "_audit" ("_id", "time", "actor", "action", "target", "details") VALUES (?, ?, ?, ?, ?, ?)`, [newId("_audit"), Date.now(), actor, op, target, details]);
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
