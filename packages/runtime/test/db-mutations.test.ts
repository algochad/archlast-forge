// Mutations on every adapter, through Executor.mutate: the answers are the same however the database runs them. MongoDB runs a mutation that touches one
// document without a transaction (mongodb.ts, `Live`) and one that needs more inside one, and these are the cases where those two differ from a plain
// transaction if they are wrong: lost updates, a function run twice, a failed mutation that left something, one document's failure in a batch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../src/server/db/types";
import type { TablesSpec } from "../src/server/docstore";
import { Executor } from "../src/server/executor";
import { v } from "../src/values";
import { dbAdapters } from "./helpers";

const tables: TablesSpec = {
  notes: {
    fields: { body: v.string(), tag: v.string(), n: v.number() },
    indexes: { by_tag_n: ["tag", "n"] },
    strict: true,
  },
  loose: { fields: {}, indexes: {}, strict: false },
};
const specs = Object.entries(tables).map(([name, t]) => ({
  name,
  indexes: t.indexes,
  searchIndexes: t.searchIndexes,
}));

for (const [label, make] of dbAdapters) {
  describe(`mutations: ${label}`, () => {
    let db: Db;
    let exec: Executor;
    let published: string[][];
    beforeEach(async () => {
      db = await make();
      await db.migrate(specs);
      published = [];
      exec = new Executor({
        db,
        tables,
        functions: new Map(),
        limits: {
          functionTimeoutMs: 5000,
          actionTimeoutMs: 5000,
          maxResultBytes: 1 << 20,
          maxDocumentBytes: 1 << 20,
        },
        publish: (t) => published.push(t),
        log: () => {},
      });
    });
    afterEach(() => db.close());

    const note = (n: number, extra: Record<string, unknown> = {}) =>
      exec.mutate((s) =>
        s.insert("notes", { body: `note ${n}`, tag: "t", n, ...extra }),
      );
    const get = async (id: string) =>
      (await exec.read((s) => s.get(id))).value as Record<string, any> | null;
    const count = async () =>
      ((await exec.read((s) => s.query("notes").collect())).value as unknown[])
        .length;

    test("a read-modify-write of one document loses no update when many run at once", async () => {
      const id = await note(0);
      await Promise.all(
        Array.from({ length: 40 }, () =>
          exec.mutate(
            async (s) =>
              void (await s.patch(id, { n: ((await s.get(id)) as any).n + 1 })),
          ),
        ),
      );
      expect((await get(id))!.n).toBe(40);
    });

    test("the same on many documents at once: each ends with its own count", async () => {
      const ids = await Promise.all(
        Array.from({ length: 8 }, (_, i) => note(i * 100)),
      );
      await Promise.all(
        ids.flatMap((id) =>
          Array.from({ length: 5 }, () =>
            exec.mutate(
              async (s) =>
                void (await s.patch(id, {
                  n: ((await s.get(id)) as any).n + 1,
                })),
            ),
          ),
        ),
      );
      expect(
        await Promise.all(ids.map(async (id) => (await get(id))!.n)),
      ).toEqual(ids.map((_, i) => i * 100 + 5));
    });

    test("a mutation that reads two documents and writes one is right, runs its after-commit work once, and publishes once", async () => {
      const a = await note(1);
      const b = await note(2);
      published = [];
      let after = 0;
      let runs = 0;
      const out = await exec.mutate(async (s, _tx, afterCommit) => {
        runs++;
        afterCommit.push(() => void after++);
        const x = (await s.get(a)) as any;
        const y = (await s.get(b)) as any;
        await s.patch(a, { n: x.n + y.n });
        return x.n + y.n;
      });
      await Bun.sleep(20);
      expect(out).toBe(3);
      expect((await get(a))!.n).toBe(3);
      expect(after).toBe(1);
      expect(
        published
          .flat()
          .filter((t) => t === "notes:by_id:" + JSON.stringify([a])),
      ).toHaveLength(1);
      expect(runs).toBeGreaterThanOrEqual(1); // MongoDB runs it again inside a transaction after the second read
    });

    test("a function that catches the error of a database call it can't have without a transaction still gets a right answer", async () => {
      const a = await note(1);
      const b = await note(2);
      const out = await exec.mutate(async (s) => {
        const x = (await s.get(a)) as any;
        let y = 0;
        try {
          y = ((await s.get(b)) as any).n;
        } catch {
          y = -100;
        }
        await s.patch(a, { n: x.n + y });
        return x.n + y;
      });
      expect(out).toBe(3);
      expect((await get(a))!.n).toBe(3);
    });

    test("a document read after it was written in the same mutation is the new one", async () => {
      const id = await note(1);
      const seen = await exec.mutate(async (s) => {
        await s.patch(id, { n: 10 });
        return ((await s.get(id)) as any).n;
      });
      expect(seen).toBe(10);
      const inserted = await exec.mutate(async (s) => {
        const fresh = await s.insert("notes", { body: "x", tag: "t", n: 5 });
        return ((await s.get(fresh)) as any).n;
      });
      expect(inserted).toBe(5);
      expect(await count()).toBe(2);
    });

    test("a mutation that writes and then throws leaves nothing, and a thrown one after a read does too", async () => {
      const id = await note(1);
      await expect(
        exec.mutate(
          async (s) => (
            await s.insert("notes", { body: "ghost", tag: "t", n: 9 }),
            Promise.reject(new Error("boom"))
          ),
        ),
      ).rejects.toThrow("boom");
      await expect(
        exec.mutate(async (s) => {
          await s.patch(id, { n: 99 });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await expect(
        exec.mutate(
          async (s) => (await s.delete(id), Promise.reject(new Error("boom"))),
        ),
      ).rejects.toThrow("boom");
      expect(await count()).toBe(1);
      expect((await get(id))!.n).toBe(1);
    });

    test("two inserts in one mutation both go in, or neither", async () => {
      await exec.mutate(async (s) => {
        await s.insert("notes", { body: "a", tag: "t", n: 1 });
        await s.insert("notes", { body: "b", tag: "t", n: 2 });
      });
      expect(await count()).toBe(2);
      await expect(
        exec.mutate(async (s) => {
          await s.insert("notes", { body: "c", tag: "t", n: 3 });
          await s.insert("notes", { body: "d", tag: "t", n: "four" as never }); // fails validation
        }),
      ).rejects.toThrow();
      expect(await count()).toBe(2);
    });

    test("delete: a document read and deleted, concurrently with a change to it, ends deleted once and nothing is lost", async () => {
      const id = await note(1);
      await Promise.all([
        exec.mutate(async (s) => {
          await s.get(id);
          await s.delete(id);
        }),
        exec.mutate((s) => s.patch(id, { n: 2 })).catch(() => {}), // either order is fine; if the delete is first the patch finds nothing
      ]);
      expect(await get(id)).toBeNull();
      await exec.mutate((s) => s.delete(id)); // deleting what is gone is nothing
    });

    test("many inserts at once all land, and one that fails fails alone", async () => {
      const ids = await Promise.all(
        Array.from({ length: 200 }, (_, i) => note(i)),
      );
      expect(new Set(ids).size).toBe(200);
      expect(await count()).toBe(200);
      // the same id twice at once (a restore does this): one wins, the other fails, nothing else is affected
      const id = "notes:" + "0".repeat(31) + "1";
      const results = await Promise.allSettled([
        ...Array.from({ length: 2 }, () =>
          exec.rewrite(async (s) =>
            s.restore("notes", id, 1, { body: "r", tag: "t", n: 1 }),
          ),
        ),
        ...Array.from({ length: 20 }, (_, i) => note(1000 + i)),
      ]);
      expect(
        results.slice(0, 2).filter((r) => r.status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.slice(2).every((r) => r.status === "fulfilled")).toBe(
        true,
      );
      expect(await count()).toBe(200 + 20 + 1);
    });

    test("a document with an odd top-level key (one that looks like an operator) can be read and changed", async () => {
      const id = await exec.mutate((s) =>
        s.insert("loose", { $weird: 1, plain: 2 }),
      );
      await exec.mutate(
        async (s) =>
          void (await s.patch(id, {
            plain: ((await s.get(id)) as any).plain + 1,
          })),
      );
      expect(await get(id)).toMatchObject({ $weird: 1, plain: 3 });
      await exec.mutate(
        async (s) => void (await s.get(id), await s.delete(id)),
      );
      expect(await get(id)).toBeNull();
    });
  });
}
