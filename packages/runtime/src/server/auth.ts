import { RedisClient } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { createAdapterFactory, type CleanedWhere } from "better-auth/adapters";
import type { AuthOptions, UserIdentity } from "../functions";
import { tableOf } from "../values";
import type { Config } from "./config";
import { RedisRateLimiter } from "./ratelimit";
import type { DocStore, TablesSpec } from "./docstore";
import type { CallHeaders, Executor, IdentityDetail } from "./executor";

type Doc = Record<string, any>;

const value = (doc: Doc, field: string) => (field === "id" ? doc._id : doc[field]);

function test(doc: Doc, w: CleanedWhere): boolean {
  const actual = value(doc, w.field);
  const insensitive = w.mode === "insensitive";
  const norm = (x: unknown) => (insensitive && typeof x === "string" ? x.toLowerCase() : x);
  const a = norm(actual);
  const b = Array.isArray(w.value) ? w.value.map(norm) : norm(w.value);
  switch (w.operator) {
    case "in":
      return (b as unknown[]).includes(a);
    case "not_in":
      return !(b as unknown[]).includes(a);
    case "contains":
      return typeof a === "string" && a.includes(b as string);
    case "starts_with":
      return typeof a === "string" && a.startsWith(b as string);
    case "ends_with":
      return typeof a === "string" && a.endsWith(b as string);
    case "ne":
      return a !== b;
    case "gt":
      return b != null && (a as any) > (b as any);
    case "gte":
      return b != null && (a as any) >= (b as any);
    case "lt":
      return b != null && (a as any) < (b as any);
    case "lte":
      return b != null && (a as any) <= (b as any);
    default:
      return b === null ? a == null : a === b;
  }
}

const matches = (doc: Doc, where: CleanedWhere[]) =>
  where.reduce((acc, w, i) => (i === 0 ? test(doc, w) : w.connector === "OR" ? acc || test(doc, w) : acc && test(doc, w)), true);

type FindOpts = { limit?: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" } };

/** Uses an id lookup or a single-field index when an AND-ed equality allows it, then filters in memory. */
async function find(store: DocStore, tables: TablesSpec, model: string, where: CleanedWhere[] = [], o: FindOpts = {}) {
  const allAnd = where.every((w, i) => i === 0 || w.connector !== "OR");
  const isEq = (w: CleanedWhere) => (w.operator ?? "eq") === "eq" && w.mode !== "insensitive" && w.value !== null;
  let docs: Doc[];
  const byId = allAnd ? where.find((w) => w.field === "id" && isEq(w)) : undefined;
  if (byId) {
    const id = byId.value;
    const doc = typeof id === "string" && id.includes(":") && tableOf(id) === model ? await store.get(id) : null;
    docs = doc ? [doc] : [];
  } else {
    const indexes = Object.entries(tables[model]?.indexes ?? {});
    let index: [string, CleanedWhere] | undefined;
    for (const w of allAnd ? where : []) {
      const found = isEq(w) && indexes.find(([, fields]) => fields[0] === w.field);
      if (found) index = [found[0], w];
      if (index) break;
    }
    const q = store.query(model);
    docs = index ? await q.withIndex(index[0], (b) => b.eq(index[1].field, index[1].value)).collect() : await q.collect();
  }
  docs = docs.filter((d) => matches(d, where));
  if (o.sortBy) {
    const { field, direction } = o.sortBy;
    const sign = direction === "desc" ? -1 : 1;
    docs.sort((x, y) => (value(x, field) > value(y, field) ? sign : value(x, field) < value(y, field) ? -sign : 0));
  }
  const start = o.offset ?? 0;
  return docs.slice(start, o.limit === undefined ? undefined : start + o.limit);
}

/** Set by the server on every auth request, replacing anything the client sent under this name. */
export const CLIENT_IP_HEADER = "x-archlast-client-ip";

/** While Better Auth resolves a session, the topics its reads touched, so the answer can be kept exactly as long as they are unchanged. */
const sessionReads = new AsyncLocalStorage<Set<string>>();

/** Better Auth adapter over the document store: auth data lives in users/sessions/accounts/verifications. */
function documentAdapter(exec: Executor, tables: TablesSpec) {
  const read = async <T>(fn: (s: DocStore) => Promise<T>) => {
    const { value, reads } = await exec.read(fn);
    const into = sessionReads.getStore();
    if (into) for (const t of reads) into.add(t);
    return value;
  };
  return createAdapterFactory({
    config: {
      adapterId: "archlast-forge",
      adapterName: "archlast-forge document store",
      usePlural: true,
      supportsJSON: true,
      supportsArrays: true,
      supportsBooleans: true,
      supportsDates: true,
      disableIdGeneration: true,
      transaction: false,
      mapKeysTransformOutput: { _id: "id" },
      // Better Auth reads the id of a row it just got back through this, to update it atomically (password reset, magic links, one-time codes).
      mapKeysTransformInput: { id: "_id" },
      customTransformInput: ({ data }) => (data instanceof Date ? data.getTime() : data),
      customTransformOutput: ({ data, fieldAttributes }) => (fieldAttributes.type === "date" && typeof data === "number" ? new Date(data) : data),
    },
    adapter: () => ({
      create: ({ model, data }) => exec.mutate(async (s) => (await s.get(await s.insert(model, data))) as any),
      findOne: ({ model, where }) => read(async (s) => ((await find(s, tables, model, where, { limit: 1 }))[0] ?? null) as any),
      findMany: ({ model, where, limit, offset, sortBy }) => read((s) => find(s, tables, model, where, { limit, offset, sortBy }) as any),
      count: ({ model, where }) => read(async (s) => (await find(s, tables, model, where)).length),
      update: ({ model, where, update }) =>
        exec.mutate(async (s) => {
          const [doc] = await find(s, tables, model, where, { limit: 1 });
          if (!doc) return null;
          await s.patch(doc._id, update as Doc);
          return (await s.get(doc._id)) as any;
        }),
      updateMany: ({ model, where, update }) =>
        exec.mutate(async (s) => {
          const docs = await find(s, tables, model, where);
          for (const d of docs) await s.patch(d._id, update);
          return docs.length;
        }),
      delete: ({ model, where }) =>
        exec.mutate(async (s) => {
          const [doc] = await find(s, tables, model, where, { limit: 1 });
          if (doc) await s.delete(doc._id);
        }),
      deleteMany: ({ model, where }) =>
        exec.mutate(async (s) => {
          const docs = await find(s, tables, model, where);
          for (const d of docs) await s.delete(d._id);
          return docs.length;
        }),
    }),
  });
}

export function createAuth(exec: Executor, tables: TablesSpec, options: AuthOptions, config: Config) {
  const userOrigins = Array.isArray(options.trustedOrigins) ? options.trustedOrigins : [];
  const sessionCreate = options.databaseHooks?.session?.create;
  // Shared across servers when Redis is configured; Better Auth's default memory store counts per process.
  const redis = config.redisUrl ? new RedisClient(config.redisUrl) : undefined;
  const auth = betterAuth({
    ...options,
    secret: config.authSecret,
    baseURL: config.authUrl,
    trustedOrigins: [...userOrigins, ...config.trustedOrigins],
    database: documentAdapter(exec, tables),
    rateLimit: {
      enabled: !config.dev,
      ...options.rateLimit,
      ...(redis && { customStorage: new RedisRateLimiter(redis, "archlast-forge:auth-rl:") }),
    },
    // The address Better Auth rate limits is the one the server worked out (it honors TRUST_PROXY) and put in this header,
    // not whatever X-Forwarded-For the client sent.
    advanced: { ...options.advanced, ipAddress: { ...options.advanced?.ipAddress, ipAddressHeaders: [CLIENT_IP_HEADER] } },
    databaseHooks: {
      ...options.databaseHooks,
      session: {
        ...options.databaseHooks?.session,
        create: {
          ...sessionCreate,
          // Banned users (set from the dashboard) can't start sessions.
          before: async (session, ctx) => {
            const user = (await exec.read((s) => s.get(session.userId))).value;
            if (user?.banned) return false;
            return sessionCreate?.before ? sessionCreate.before(session, ctx) : undefined;
          },
        },
      },
    },
  });
  // Every signed-in call resolves its caller. Better Auth's getSession spends about a millisecond on that (async WebCrypto, adapter layers);
  // checking the signed cookie and reading the session straight from the store takes a few hundredths. It applies when nothing could change
  // what a session means (no plugins, no external session storage, no secret rotation); anything else goes through Better Auth.
  const o = options as { plugins?: unknown[]; secondaryStorage?: unknown; secrets?: unknown; session?: { expiresIn?: number; updateAge?: number } };
  const direct = Boolean(config.authSecret) && !o.plugins?.length && !o.secondaryStorage && !o.secrets;
  const expiresInMs = (o.session?.expiresIn ?? 7 * 86400) * 1000;
  const updateAgeMs = (o.session?.updateAge ?? 86400) * 1000;
  let cookieName: string | undefined;
  const cookieNameOf = async () => (cookieName ??= (await auth.$context).authCookies.sessionToken.name);

  // Signature checks by cookie value: the same signed cookie arrives on every call a signed-in client makes, and the result only depends on the secret.
  // Only the check is remembered; the session itself is read from the store on every call, so a revoked session stops working at once.
  const checked = new Map<string, string | null>();
  const check = (value: string) => {
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const token = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(createHmac("sha256", config.authSecret!).update(token).digest("base64"));
    return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
  };

  /** The token in a request's signed session cookie, or undefined when there isn't one or its signature doesn't match. */
  const verifiedToken = (cookie: string | undefined, name: string) => {
    const at = cookie?.indexOf(name + "=") ?? -1;
    if (!cookie || at < 0 || (at > 0 && cookie[at - 1] !== " " && cookie[at - 1] !== ";")) return undefined;
    const end = cookie.indexOf(";", at);
    const raw = cookie.slice(at + name.length + 1, end < 0 ? undefined : end);
    let token = checked.get(raw);
    if (token === undefined) {
      try {
        token = check(decodeURIComponent(raw));
      } catch {
        token = null;
      }
      if (checked.size >= 20_000) checked.clear(); // shortcut: a flush rather than an LRU; the next calls pay one HMAC each again
      checked.set(raw, token);
    }
    return token ?? undefined;
  };

  const slow = async (headers: CallHeaders): Promise<IdentityDetail> => {
    const reads = new Set<string>();
    const s = await sessionReads.run(reads, () => auth.api.getSession({ headers: new Headers(headers) }));
    if (!s) return { identity: null };
    const identity = { userId: s.user.id as UserIdentity["userId"], sessionId: s.session.id, email: s.user.email, name: s.user.name };
    // Kept only when the answer rests on the session row (with Better Auth's cookie cache on it answers from the cookie and reads nothing), until the session
    // ends or is due for its refresh, which is a write that ends the answer anyway.
    const ends = new Date(s.session.expiresAt as unknown as string | number | Date).getTime();
    const pinned = [...reads].some((t) => t.startsWith("sessions:")) && Number.isFinite(ends);
    return pinned ? { identity, topics: [...reads], until: Math.min(ends, ends - expiresInMs + updateAgeMs) } : { identity };
  };

  // Who is calling, and for the direct path also what the answer rests on: the topics it read, which a write to invalidates, and the time it
  // holds until (the session's end, or when Better Auth would refresh it). The server keeps such an answer instead of asking again.
  exec.identityDetail = async (headers: CallHeaders): Promise<IdentityDetail> => {
    const token = direct ? verifiedToken(headers.cookie, await cookieNameOf()) : undefined;
    if (!token) return slow(headers);
    const { value, reads } = await exec.read(async (s) => {
      const [session] = await find(s, tables, "sessions", [{ field: "token", value: token, operator: "eq", connector: "AND", mode: "sensitive" }], { limit: 1 });
      if (!session || session.expiresAt <= Date.now()) return null; // revoked or expired
      // Due for Better Auth's refresh of the session's expiry: let it do that.
      const refreshAt = session.expiresAt - expiresInMs + updateAgeMs;
      if (refreshAt <= Date.now()) return undefined;
      const user = await s.get(session.userId);
      return user ? { identity: { userId: user._id as UserIdentity["userId"], sessionId: session._id, email: user.email, name: user.name }, until: Math.min(session.expiresAt, refreshAt) } : null;
    });
    if (value === undefined) return slow(headers);
    return value ? { identity: value.identity, topics: [...reads], until: value.until } : { identity: null };
  };
  exec.resolveIdentity = async (headers: CallHeaders) => (await exec.identityDetail(headers)).identity;
  return auth;
}
