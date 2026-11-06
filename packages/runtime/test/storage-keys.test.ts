import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { adminOp, type AdminDeps } from "../src/server/admin-ops";
import { createSqliteDb } from "../src/server/db/sqlite";
import { migrateSystem } from "../src/server/system";
import type { Db } from "../src/server/db/types";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs } from "../src/server/project";
import { LocalStorage, S3Storage, type Storage } from "../src/server/storage";
import { tempDir } from "./helpers";

// A `_storage` row names an object in storage. With S3 the backups sit in the same bucket under `_backups/`, so a row an admin writes by hand
// must not be able to name one: the dashboard would sign a download link for it (`files`, viewer) or delete it (`deleteFile`).
const requests: string[] = [];
let stub: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${decodeURIComponent(new URL(req.url).pathname)}`);
      return new Response(null, { status: 204 });
    },
  });
});
afterAll(() => stub.stop(true));

const backupKey = "_backups/backup-2026-11-05T00-00-00Z.tar.gz";

async function setup(storage: Storage) {
  const project = await loadProject(join(import.meta.dir, "fixture"));
  const db: Db = createSqliteDb(join(tempDir(), "app.db"));
  await db.migrate(tableSpecs(project.tables));
  await migrateSystem(db);
  const exec = new Executor({ db, tables: project.tables, functions: project.functions, storage, publish: () => {}, log: () => {} });
  const d = { db, exec, functions: project.functions, tables: project.tables, crons: [], storage, serverId: "test" } as unknown as AdminDeps;
  const op = (name: string, args: object) => adminOp(d, name, args, "admin@example.com");
  return { db, exec, op };
}

const stores: [string, () => Storage][] = [
  ["S3", () => new S3Storage({ endpoint: stub.url.href.replace(/\/$/, ""), bucket: "forge", accessKeyId: "k", secretAccessKey: "s", region: "us-east-1" })],
  ["local", () => new LocalStorage({ dir: tempDir(), publicUrl: "http://localhost:3000", secret: "s".repeat(32) })],
];

describe.each(stores)("%s storage", (_, make) => {
  test("the dashboard can't write a _storage row whose key names something other than a file", async () => {
    const { db, op } = await setup(make());
    await expect(op("insertDoc", { table: "_storage", value: { key: backupKey } })).rejects.toThrow("must match");
    const id = (await op("insertDoc", { table: "_storage", value: { key: crypto.randomUUID() } })) as string;
    await expect(op("patchDoc", { id, value: { key: backupKey } })).rejects.toThrow("must match");
    await expect(op("replaceDoc", { id, value: { key: `../${backupKey}` } })).rejects.toThrow("must match");
    await db.close();
  });

  test("a row that names a backup anyway (written before keys were checked) gets no link and deletes no object", async () => {
    const storage = make();
    const { db, exec, op } = await setup(storage);
    const id = `_storage:${crypto.randomUUID().replaceAll("-", "")}`;
    await db.execute(`INSERT INTO "_storage" ("_id", "_creationTime", "doc") VALUES (?, ?, ?)`, [id, Date.now(), JSON.stringify({ key: backupKey })]);
    const files = (await op("files", {})) as { page: { _id: string; url: string | null }[] };
    expect(files.page.find((f) => f._id === id)?.url).toBeNull();
    expect(() => storage.getPresignedUrl(backupKey)).toThrow("Not a storage key");
    requests.length = 0;
    await op("deleteFile", { id }).catch(() => {});
    await Bun.sleep(50); // the object is deleted after the commit
    expect(requests.filter((r) => r.includes("_backups"))).toEqual([]);
    // ctx.storage takes only a file's id: another table's document with a `key` field is not a file.
    const listId = await exec.mutate((s) => s.insert("lists", { name: "not a file" }));
    expect((await exec.read((s) => (exec as any).storage(s).getUrl(listId))).value).toBeNull();
    await exec.mutate((s, _tx, after) => (exec as any).storage(s, after).delete(listId));
    expect((await exec.read((s) => s.get(listId))).value).not.toBeNull();
    await db.close();
  });
});
