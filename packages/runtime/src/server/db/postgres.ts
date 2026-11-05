import { SQL } from "bun";
import { pointReads } from "./coalesce";
import { indexPlan, PREFIX, tableDDL } from "./migrate";
import { isTooManyClients } from "./pool-size";
import { scopedTx, type Db, type DbTx, type Dialect, type Row } from "./types";

const field = (name: string) => `"doc"->'${name}'`;
/** A field to compare with an id: `_id` is a column, anything else a document field. */
const postgresField = (name: string) => (name === "_id" || name === "_creationTime" ? `"${name}"` : field(name));

export const postgresDialect: Dialect = {
  name: "postgres",
  realType: "DOUBLE PRECISION",
  jsonType: "JSONB",
  // Bound as text: Bun would JSON-encode a string bound straight to jsonb a second time.
  jsonParam: "?::text::jsonb",
  field,
  valueParam: "?::text::jsonb",
  encode: (value) => JSON.stringify(value),
  startsWith: (name, prefix) => ({ sql: `starts_with("doc"->>'${name}', ?)`, params: [prefix] }),
  fieldEquals(name, value) {
    if (value === undefined) return { sql: `${field(name)} IS NULL`, params: [] };
    return { sql: `${field(name)} = ?::text::jsonb`, params: [JSON.stringify(value)] };
  },
  listIndexesSql: `SELECT indexname AS name FROM pg_indexes WHERE tablename = ?`,
  // One parameter holding every row as JSON: the statement is the same for 1 row or 2,000, so the server prepares it once, and it isn't a
  // long list of bound values to parse.
  bulkInsert: (table, rows) => ({
    sql: `INSERT INTO "${table}" ("_id", "_creationTime", "doc") SELECT r->>'i', (r->>'t')::float8, r->'d' FROM jsonb_array_elements(?::text::jsonb) AS r`,
    params: ["[" + rows.map((r) => `{"i":${JSON.stringify(r.id)},"t":${r.time},"d":${r.json}}`).join(",") + "]"],
  }),
  // 100 rows: 15.6 ms as 100 statements, 2.0 ms as one.
  bulkUpdate: (table, rows) => ({
    sql: `UPDATE "${table}" AS t SET "doc" = d.doc FROM (SELECT r->>'i' AS id, r->'d' AS doc FROM jsonb_array_elements(?::text::jsonb) AS r) AS d WHERE t."_id" = d.id`,
    params: ["[" + rows.map((r) => `{"i":${JSON.stringify(r.id)},"d":${r.json}}`).join(",") + "]"],
  }),
  // One LATERAL join instead of a statement per parent (100 parents, 2 children each: 14.6 ms in 100 statements, 1.2 ms in one).
  childrenOf: (table, field, parents, orderBy, take) => ({
    sql: `SELECT c."_id", c."_creationTime", c."doc" FROM jsonb_array_elements(?::text::jsonb) WITH ORDINALITY AS p(v, ord) CROSS JOIN LATERAL (SELECT "_id", "_creationTime", "doc" FROM "${table}" WHERE ${postgresField(field)} = p.v ORDER BY ${orderBy} LIMIT ${take}) c ORDER BY p.ord, ${orderBy}`,
    params: [JSON.stringify(parents)],
  }),
  countChildren: (table, field, parents) => ({
    sql: `SELECT (p.ord - 1) AS k, c.n FROM jsonb_array_elements(?::text::jsonb) WITH ORDINALITY AS p(v, ord) CROSS JOIN LATERAL (SELECT count(*) AS n FROM "${table}" WHERE ${postgresField(field)} = p.v) c`,
    params: [JSON.stringify(parents)],
  }),
  async numberStats(run, table, name, where, params) {
    // The field is read once per document (OFFSET 0 keeps the planner from folding the inner query back in and reading it for each use: that
    // was twice as slow), as jsonb; numbers become numeric, which adds integers exactly.
    const [row] = await run(
      `SELECT count(*) AS "rows", count(*) FILTER (WHERE "t" = 'number') AS "n", count(*) FILTER (WHERE "t" NOT IN ('number', 'null')) AS "bad",
         count(*) FILTER (WHERE "t" = 'number' AND "v" <> trunc("v")) AS "nonint", sum("v") AS "sum", min("v") AS "min", max("v") AS "max"
       FROM (SELECT jsonb_typeof("x") AS "t", CASE WHEN jsonb_typeof("x") = 'number' THEN "x"::numeric END AS "v" FROM (SELECT "doc"->'${name}' AS "x" FROM "${table}" ${where} OFFSET 0) AS "f") AS "s"`,
      params,
    );
    if (!row) return undefined;
    const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
    return { rows: Number(row.rows), n: Number(row.n), bad: Number(row.bad), nonint: Number(row.nonint), sum: Number(row.sum ?? 0), min: num(row.min), max: num(row.max) };
  },
  searchWrite: () => [], // the GIN expression index stays in sync by itself
  searchSql(table, _index, fieldName, terms, filters, limit) {
    const vector = `to_tsvector('simple', coalesce("doc"->>'${fieldName}', ''))`;
    const query = terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(" & ");
    return {
      sql: `SELECT "_id", "_creationTime", "doc" FROM "${table}" WHERE ${vector} @@ to_tsquery('simple', ?)${filters.map((f) => ` AND ${f.sql}`).join("")} ORDER BY ts_rank(${vector}, to_tsquery('simple', ?), 1) DESC, "_creationTime" LIMIT ${limit}`,
      params: [query, ...filters.flatMap((f) => f.params), query],
    };
  },
};

/** `?` placeholders as `$1, $2, …`. The same statements come back all the time, so the rewrite is kept. */
const rewritten = new Map<string, string>();
const toPg = (sql: string) => {
  let out = rewritten.get(sql);
  if (out === undefined) {
    let i = 0;
    out = sql.replace(/\?/g, () => `$${++i}`);
    if (rewritten.size >= 5000) rewritten.clear();
    rewritten.set(sql, out);
  }
  return out;
};

/** Thrown inside a read that tried a second statement outside a transaction: it is run again inside one. */
class NeedsSnapshot extends Error {}

/**
 * Pooled connections: `max` for reads (CPU count × 2 by default) and `writeMax` for write transactions (twice that). Writes run SERIALIZABLE;
 * callers retry on conflicts. A write waits for its commit and for the round trips of its statements, which more connections hide (6,100 patches a
 * second on 32 connections against 4,200 on 8), where a read is quick and a crowd of connections only competes for the CPU (47,000 reads a second
 * on 8 connections against 33,000 on 32). So they are separate pools. Bun opens every connection of a pool at its first query and keeps them, so
 * `max + writeMax` is what a process holds from its start: `pool-size.ts` sizes them to fit the database.
 */
let hintedAt = 0;
/** The line that turns "sorry, too many clients already" into what to do about it; at most once a minute in a process or thread. */
function tooManyClients(read: number, write: number) {
  if (Date.now() - hintedAt < 60_000) return;
  hintedAt = Date.now();
  console.warn(
    `Postgres refused a connection: "too many clients already" (max_connections is reached). This pool holds ${read} read + ${write} write connections; ` +
      `each function-runtime process (RUNTIME_WORKERS) of every server holds DATABASE_POOL_SIZE + DATABASE_WRITE_POOL_SIZE, plus 3 for telemetry. ` +
      `Lower those or raise Postgres's max_connections; the engine's start-up line "Postgres connections: …" shows its numbers.`,
  );
}

export function createPostgresDb(url: string, max = navigator.hardwareConcurrency * 2, writeMax = max * 2): Db {
  const sql = new SQL(url, { max });
  const writer = writeMax === max ? sql : new SQL(url, { max: writeMax });
  const txOf = (s: SQL): DbTx => ({
    query: async (q, params = []) => [...(await s.unsafe(toPg(q), params as any[]))],
    execute: async (q, params = []) => {
      await s.unsafe(toPg(q), params as any[]);
    },
  });

  // A read that makes one statement needs no transaction: a statement sees one snapshot by itself, and BEGIN and COMMIT are two more round
  // trips (a read went from 488 µs to 148 µs). It can't be known in advance, so a read starts without one, and if it makes a second statement
  // it is thrown away and run again inside one (a read is deterministic and writes nothing; the executor already re-runs reads). When most
  // reads turn out to need the transaction, trying first is a loss, so it is skipped until a probe finds otherwise.
  // And get(id) is the read there is most of: those that arrive while every connection is busy go out together as one statement.
  const GET = /^SELECT "_id", "_creationTime", "doc" FROM "([^"]+)" WHERE "_id" = \?$/;
  const point = pointReads<Row>(
    max,
    async (table, id) => (await sql.unsafe(toPg(`SELECT "_id", "_creationTime", "doc" FROM "${table}" WHERE "_id" = ?`), [id]))[0],
    async (table, ids) => new Map((await sql.unsafe(`SELECT "_id", "_creationTime", "doc" FROM "${table}" WHERE "_id" = ANY (SELECT jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify(ids)])).map((r: Row) => [r._id as string, r])),
  );
  let missRate = 0;
  let probe = 0;
  const tryWithoutTransaction = () => missRate < 0.5 || ++probe % 64 === 0;
  async function readWithoutTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<{ value: T } | undefined> {
    let statements = 0;
    let tripped = false;
    const scoped = scopedTx({
      query: async (q, params = []) => {
        if (statements++ > 0) {
          tripped = true;
          throw new NeedsSnapshot();
        }
        const get = GET.exec(q);
        if (get && typeof params[0] === "string" && params.length === 1) {
          const row = await point(get[1]!, params[0]);
          return row ? [row] : [];
        }
        return [...(await sql.unsafe(toPg(q), params as any[]))];
      },
      execute: async () => {
        tripped = true;
        throw new NeedsSnapshot();
      },
    });
    try {
      const value = await fn(scoped);
      return tripped ? undefined : { value }; // a function that caught the error and went on still has to be run again
    } catch (e) {
      if (tripped || e instanceof NeedsSnapshot) return undefined;
      throw e;
    } finally {
      scoped.end();
    }
  }

  const db: Db = {
    dialect: postgresDialect,
    ...txOf(sql),
    async transaction(mode, fn, options) {
      if (mode === "read" && options?.rerunnable && tryWithoutTransaction()) {
        const done = await readWithoutTransaction(fn);
        missRate = missRate * 0.97 + (done ? 0 : 0.03);
        if (done) return done.value;
      }
      const isolation = mode === "write" ? "isolation level serializable" : "isolation level repeatable read read only";
      // Wrapped: Bun pipelines an array returned from begin() as queries.
      const out = await (mode === "write" ? writer : sql).begin(isolation, async (tx) => {
        const scoped = scopedTx(txOf(tx));
        try {
          return { value: await fn(scoped) };
        } finally {
          scoped.end();
        }
      });
      return out.value;
    },
    async migrate(tables) {
      await db.transaction("write", async (tx) => {
        await tx.execute("SELECT pg_advisory_xact_lock(727274)");
        for (const t of tables) await tx.execute(tableDDL(postgresDialect, t.name));
      });
      // CONCURRENTLY can't run in a transaction, but it doesn't block writes on large tables.
      const conn = await sql.reserve();
      try {
        await conn.unsafe("SELECT pg_advisory_lock(727275)");
        for (const t of tables) {
          const plan = indexPlan(postgresDialect, t);
          const existing = (
            (await conn.unsafe(
              `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class r ON r.oid = i.indrelid WHERE r.relname = $1`,
              [t.name],
            )) as { name: string; valid: boolean }[]
          ).filter((r) => r.name.startsWith(PREFIX));
          // An interrupted concurrent build leaves an invalid index behind; rebuild it.
          for (const r of existing) if (!plan.has(r.name) || !r.valid) await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${r.name}"`);
          for (const [name, body] of plan)
            if (!existing.some((r) => r.name === name && r.valid)) await conn.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ${body}`);
        }
      } finally {
        await conn.unsafe("SELECT pg_advisory_unlock(727275)").catch(() => {});
        conn.release();
      }
    },
    close: async () => {
      await Promise.all([sql.close(), writer === sql ? undefined : writer.close()]);
    },
  };
  // Postgres refusing a connection is about the pools' sizes, not the statement that hit it: say so once a minute, with what to change.
  for (const name of ["query", "execute", "transaction", "migrate"] as const) {
    const fn = db[name] as (...a: unknown[]) => Promise<unknown>;
    (db as unknown as Record<string, unknown>)[name] = (...a: unknown[]) =>
      fn(...a).catch((e: unknown) => {
        if (isTooManyClients(e)) tooManyClients(max, writeMax);
        throw e;
      });
  }
  return db;
}
