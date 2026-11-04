// Point reads that arrive faster than the database answers them go out together. A `get(id)` is one statement or one operation, and 64 of them at
// once on a pool of 8 connections is 8 in flight and 56 waiting: when one finishes, the 56 can be asked for as one `_id IN (…)`, a fraction of the
// work for the driver (which is where a Bun process spends its CPU: MongoDB's driver costs about 150 µs of JavaScript an operation) and for the
// server. Nothing waits for company: with a connection free a read goes out at once. Only reads outside a transaction (the engine's reads that
// make a single statement); a transaction's statements keep their order.

/** The most ids asked for in one statement. */
const MAX_BATCH = 500;

export type PointRead<T> = (table: string, id: string) => Promise<T | undefined>;

/**
 * `read(table, id)` gives the row with that id, or undefined. `one` fetches a single row; `many` fetches several by id (a missing id is absent
 * from the map). `limit` is how many may be in flight at once (the pool's size).
 */
export function pointReads<T>(limit: number, one: (table: string, id: string) => Promise<T | undefined>, many: (table: string, ids: string[]) => Promise<Map<string, T>>): PointRead<T> {
  type Waiter = { resolve(row: T | undefined): void; reject(error: unknown): void };
  let inflight = 0;
  /** table -> id -> who is waiting for it */
  const pending = new Map<string, Map<string, Waiter[]>>();

  function settled() {
    inflight--;
    drain();
  }

  function drain() {
    while (inflight < limit && pending.size) {
      const [table, ids] = pending.entries().next().value!;
      const batch = new Map<string, Waiter[]>();
      for (const [id, waiters] of ids) {
        batch.set(id, waiters);
        ids.delete(id);
        if (batch.size >= MAX_BATCH) break;
      }
      if (!ids.size) pending.delete(table);
      inflight++;
      const wanted = [...batch.keys()];
      const run = wanted.length === 1 ? one(table, wanted[0]!).then((row) => new Map(row === undefined ? [] : [[wanted[0]!, row]])) : many(table, wanted);
      run.then(
        (rows) => {
          for (const [id, waiters] of batch) for (const w of waiters) w.resolve(rows.get(id));
          settled();
        },
        (error) => {
          for (const waiters of batch.values()) for (const w of waiters) w.reject(error);
          settled();
        },
      );
    }
  }

  return (table, id) =>
    new Promise<T | undefined>((resolve, reject) => {
      let ids = pending.get(table);
      if (!ids) pending.set(table, (ids = new Map()));
      const waiters = ids.get(id);
      if (waiters) waiters.push({ resolve, reject });
      else ids.set(id, [{ resolve, reject }]);
      drain();
    });
}
