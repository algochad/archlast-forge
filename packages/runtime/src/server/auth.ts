import { RedisClient } from "bun";
import { betterAuth } from "better-auth";
import { createAdapterFactory, type CleanedWhere } from "better-auth/adapters";
import type { AuthOptions, UserIdentity } from "../functions";
import { tableOf } from "../values";
import type { Config } from "./config";
import { RedisRateLimiter } from "./ratelimit";
import type { DocStore, TablesSpec } from "./docstore";
import type { CallHeaders, Executor } from "./executor";

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

/** Better Auth adapter over the document store: auth data lives in users/sessions/accounts/verifications. */
function documentAdapter(exec: Executor, tables: TablesSpec) {
  const read = async <T>(fn: (s: DocStore) => Promise<T>) => (await exec.read(fn)).value;
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
  exec.resolveIdentity = async (headers: CallHeaders): Promise<UserIdentity | null> => {
    const s = await auth.api.getSession({ headers: new Headers(headers) });
    return s ? { userId: s.user.id as UserIdentity["userId"], sessionId: s.session.id, email: s.user.email, name: s.user.name } : null;
  };
  return auth;
}
