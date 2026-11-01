import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb, serverMemory, sqliteMemory } from "../src/server/db/sqlite";

const MiB = 2 ** 20;
const GiB = 2 ** 30;

test("SQLite's memory follows the server's RAM, within bounds", () => {
  expect(sqliteMemory(8 * GiB, 5)).toEqual({ mmapBytes: 0x7fff0000, cacheKiB: Math.floor((512 * MiB) / 5 / 1024) }); // mmap at SQLite's 2 GiB cap
  expect(sqliteMemory(512 * MiB, 5)).toEqual({ mmapBytes: 128 * MiB, cacheKiB: Math.floor((32 * MiB) / 5 / 1024) });
  expect(sqliteMemory(64 * MiB, 5)).toEqual({ mmapBytes: 64 * MiB, cacheKiB: Math.floor((8 * MiB) / 5 / 1024) }); // the floors
  expect(sqliteMemory(256 * GiB, 1).cacheKiB).toBe(1024 * 1024); // a 1 GiB page cache at most
  expect(serverMemory()).toBeGreaterThan(0);
  expect(serverMemory()).toBeLessThanOrEqual(totalmem());
});

test("every connection gets the sizes; without a RAM figure SQLite keeps its defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afx-sqlmem-"));
  const sized = createSqliteDb(join(dir, "app.db"), 4, 8 * GiB);
  const want = sqliteMemory(8 * GiB, 5);
  const pragmas = async (run: (sql: string) => Promise<any[]>) => ({
    cache: (await run("PRAGMA cache_size"))[0].cache_size,
    mmap: (await run("PRAGMA mmap_size"))[0].mmap_size,
    temp: (await run("PRAGMA temp_store"))[0].temp_store,
  });
  const expected = { cache: -want.cacheKiB, mmap: want.mmapBytes, temp: 2 };
  expect(await pragmas((sql) => sized.query(sql))).toEqual(expected); // a reader
  expect(await pragmas((sql) => sized.transaction("write", (tx) => tx.query(sql)))).toEqual(expected); // the writer
  await sized.close();

  const plain = createSqliteDb(join(dir, "telemetry.db"), 2);
  expect(await pragmas((sql) => plain.query(sql))).toEqual({ cache: -2000, mmap: 0, temp: 0 });
  await plain.close();
});
