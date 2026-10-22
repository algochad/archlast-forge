import { expect, test } from "bun:test";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";
import { DocStore } from "../src/server/docstore";
import { Executor } from "../src/server/executor";
import { loadProject } from "../src/server/project";
import { S3Storage } from "../src/server/storage";
import { tempDir } from "./helpers";

// Needs an S3-compatible server, e.g. RustFS from docker-compose.yml with bucket "forge".
const endpoint = process.env.TEST_S3_ENDPOINT;
const s3 = () =>
  new S3Storage({
    endpoint: endpoint!,
    bucket: process.env.TEST_S3_BUCKET ?? "forge",
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "forgeadmin",
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "forgeadmin",
    region: "us-east-1",
  });

test.skipIf(!endpoint)("presigned PUT and GET round trip, then delete", async () => {
  const storage = s3();
  const key = crypto.randomUUID();
  const put = await fetch(storage.putPresignedUrl(key, { contentType: "text/plain" }), {
    method: "PUT",
    body: "hello",
    headers: { "content-type": "text/plain" },
  });
  expect(put.status).toBe(200);
  expect(await (await fetch(storage.getPresignedUrl(key))).text()).toBe("hello");
  await storage.delete(key);
  expect((await fetch(storage.getPresignedUrl(key))).status).toBe(404);
});

test.skipIf(!endpoint)("browsers may upload cross-origin (CORS preflight)", async () => {
  const res = await fetch(s3().putPresignedUrl(crypto.randomUUID()), {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173", "access-control-request-method": "PUT" },
  });
  expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
});

test.skipIf(!endpoint)("ctx.storage: metadata row commits first, the object is deleted after commit", async () => {
  const project = await loadProject(join(import.meta.dir, "fixture"));
  const db = createSqliteDb(join(tempDir(), "app.db"));
  await db.migrate(Object.entries(project.tables).map(([name, t]) => ({ name, indexes: t.indexes })));
  const published: string[][] = [];
  const exec = new Executor({ db, tables: project.tables, functions: project.functions, storage: s3(), publish: (t) => published.push(t), log: () => {} });
  type Ctx = { getUrl(id: string): Promise<string>; generateUploadUrl(o: object): Promise<{ uploadUrl: string; storageId: string }>; delete(id: string): Promise<void> };
  const storageOf = (s: DocStore, after?: (() => unknown)[]): Ctx => (exec as any).storage(s, after);

  const { uploadUrl, storageId } = await exec.mutate((s, _tx, after) => storageOf(s, after).generateUploadUrl({ contentType: "text/plain" }));
  expect(storageId).toMatch(/^_storage:/);
  expect(published.flat()).toContain("_storage");
  await fetch(uploadUrl, { method: "PUT", body: "file body", headers: { "content-type": "text/plain" } });
  const url = (await exec.read((s) => storageOf(s).getUrl(storageId))).value;
  expect(await (await fetch(url)).text()).toBe("file body");

  await exec.mutate((s, _tx, after) => storageOf(s, after).delete(storageId));
  expect((await exec.read((s) => s.get(storageId))).value).toBeNull();
  await Bun.sleep(200); // after-commit deletion
  expect((await fetch(url)).status).toBe(404);
  await db.close();
});
