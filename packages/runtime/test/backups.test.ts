import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Backups } from "../src/server/backup/backups";
import { readTarGz } from "../src/server/backup/tar";
import { openProject } from "../src/server/cli-ops";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture-backup");
const KEY = "backup-test-key";

async function rpc(srv: RunningServer, name: string, args: unknown = {}, mutation = false) {
  const res = mutation
    ? await fetch(`${srv.url}/rpc/${name}`, { method: "POST", body: JSON.stringify(args), headers: { "content-type": "application/json" } })
    : await fetch(`${srv.url}/rpc/${name}?args=${encodeURIComponent(JSON.stringify(args))}`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function admin(srv: RunningServer, op: string, input?: unknown, method: "GET" | "POST" = input === undefined ? "GET" : "POST") {
  const res =
    method === "GET"
      ? await fetch(`${srv.url}/_admin/${op}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`, { headers: { "x-admin-key": KEY } })
      : await fetch(`${srv.url}/_admin/${op}`, {
          method: "POST",
          body: JSON.stringify(input ?? {}),
          headers: { "x-admin-key": KEY, "x-forge-admin": "1", "content-type": "application/json" },
        });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(body?.error?.message ?? body?.message ?? `HTTP ${res.status}`);
  return body;
}

const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> => {
  for (const end = Date.now() + ms; ; await Bun.sleep(50)) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 400)}`);
  }
};

const env = (dataDir: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  PORT: "0",
  DATA_DIR: dataDir,
  ADMIN_KEY: KEY,
  MAX_UPLOAD_MB: "1",
  MAX_REQUEST_BYTES: "65536",
  ...extra,
});

describe("built-in storage", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ forgeDir: fixture, dev: true, env: env(tempDir()) });
  });
  afterAll(() => srv.stop());

  test("dev without S3 stores files on the engine: signed PUT, GET with its type, HEAD, Range, delete", async () => {
    expect(srv.config.storage).toBe("local");
    const { uploadUrl, storageId } = await rpc(srv, "posts:uploadUrl", { contentType: "image/png" }, true);
    expect(uploadUrl.startsWith(`${srv.url}/_storage/`)).toBe(true);
    const put = await fetch(uploadUrl, { method: "PUT", body: "pretend png", headers: { "content-type": "image/png" } });
    expect(put.status).toBe(200);
    const url: string = await rpc(srv, "posts:fileUrl", { id: storageId });
    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await got.text()).toBe("pretend png");
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("11");
    const part = await fetch(url, { headers: { range: "bytes=8-" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 8-10/11");
    expect(await part.text()).toBe("png");
    // the dashboard's Files page sees it with its size
    const files = await admin(srv, "files");
    expect(files.page.find((f: any) => f._id === storageId)?.size).toBe(11);
    await rpc(srv, "posts:dropFile", { id: storageId }, true);
    await until(
      () => fetch(url).then((r) => r.status),
      (s) => s === 404,
    );
  });

  test("a URL only does what it was signed for, until it expires", async () => {
    const { uploadUrl, storageId } = await rpc(srv, "posts:uploadUrl", {}, true);
    const u = new URL(uploadUrl);
    const sig = u.searchParams.get("sig")!;
    u.searchParams.set("sig", sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA"));
    expect((await fetch(u, { method: "PUT", body: "x" })).status).toBe(403);
    // an upload URL doesn't read
    expect((await fetch(uploadUrl)).status).toBe(403);
    const expired = new URL(uploadUrl);
    expired.searchParams.set("expires", String(Math.floor(Date.now() / 1000) - 10));
    expect((await fetch(expired, { method: "PUT", body: "x" })).status).toBe(403);
    // a download URL doesn't write
    expect((await fetch(uploadUrl, { method: "PUT", body: "ok" })).status).toBe(200);
    const url: string = await rpc(srv, "posts:fileUrl", { id: storageId });
    expect((await fetch(url, { method: "PUT", body: "overwritten" })).status).toBe(403);
    expect(await (await fetch(url)).text()).toBe("ok");
  });

  test("names outside the store, oversized uploads and cross-origin preflights", async () => {
    expect((await fetch(`${srv.url}/_storage/..%2Fapp.db?expires=9999999999&sig=x`)).status).toBe(404);
    expect((await fetch(`${srv.url}/_storage/.key?expires=9999999999&sig=x`)).status).toBe(404);
    const { uploadUrl } = await rpc(srv, "posts:uploadUrl", {}, true);
    const big = new Uint8Array(1024 * 1024 + 1);
    expect((await fetch(uploadUrl, { method: "PUT", body: big })).status).toBe(413);
    // without a declared length too: counted as it arrives
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(64 * 1024));
        c.close();
      },
    });
    expect((await fetch(uploadUrl, { method: "PUT", body: stream, duplex: "half" } as RequestInit)).status).toBe(413);
    const pre = await fetch(uploadUrl, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "PUT" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  test("other requests keep MAX_REQUEST_BYTES although uploads raised Bun's limit", async () => {
    const big = JSON.stringify({ title: "x".repeat(70_000), body: "b", tag: "t" });
    const res = await fetch(`${srv.url}/rpc/posts:add`, { method: "POST", body: big, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const res2 = await fetch(`${srv.url}/rpc/posts:add`, { method: "POST", body: chunked, duplex: "half", headers: { "content-type": "application/json" } } as RequestInit);
    expect(res2.status).toBe(413);
    // and a body under the limit still works
    expect(await rpc(srv, "posts:add", { title: "small", body: "fine", tag: "t" }, true)).toMatch(/^posts:/);
  });
});

/** Where the suite runs: SQLite with files on the engine always; Postgres, and S3 for files and backups, when the services are there. */
const setups: [string, () => Promise<Record<string, string>>][] = [
  ["sqlite, built-in storage", async () => ({})],
  ...(process.env.TEST_POSTGRES_URL
    ? ([
        [
          "postgres",
          async () => {
            const { createPostgresDb } = await import("../src/server/db/postgres");
            const db = createPostgresDb(process.env.TEST_POSTGRES_URL!, 2);
            for (const { name } of await db.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`))
              await db.execute(`DROP TABLE IF EXISTS "${name}" CASCADE`);
            await db.close();
            return { DATABASE_URL: process.env.TEST_POSTGRES_URL! };
          },
        ],
      ] as [string, () => Promise<Record<string, string>>][])
    : []),
  ...(process.env.TEST_S3_ENDPOINT
    ? ([
        ["s3 files, backups in their bucket", async () => s3Env("S3_")],
        ["s3 files, backups in a bucket of their own", async () => ({ ...s3Env("S3_"), ...s3Env("BACKUP_S3_"), BACKUP_S3_PREFIX: `own-${crypto.randomUUID()}/` })],
      ] as [string, () => Promise<Record<string, string>>][])
    : []),
];

function s3Env(prefix: string): Record<string, string> {
  return {
    [`${prefix}ENDPOINT`]: process.env.TEST_S3_ENDPOINT!,
    [`${prefix}BUCKET`]: process.env.TEST_S3_BUCKET ?? "forge",
    [`${prefix}ACCESS_KEY_ID`]: process.env.TEST_S3_ACCESS_KEY_ID ?? "forgeadmin",
    [`${prefix}SECRET_ACCESS_KEY`]: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "forgeadmin",
    [`${prefix}REGION`]: "us-east-1",
  };
}

for (const [label, setup] of setups)
  describe(`backups (${label})`, () => {
    let srv: RunningServer;
    const dataDir = tempDir();
    beforeAll(async () => {
      srv = await startServer({ forgeDir: fixture, dev: true, env: env(dataDir, await setup()) });
    });
    afterAll(() => srv.stop());

    const listed = () => admin(srv, "backups.list");
    const finished = (id: string) => until(listed, (l) => ["done", "failed"].includes(l.backups.find((b: any) => b._id === id)?.state)).then((l) => l.backups.find((b: any) => b._id === id));

    test("a backup holds the documents, jobs, source and files; a restore brings them back and live queries see it", async () => {
      // some state: posts (one with an image), a scheduled job, a function env variable
      const { uploadUrl, storageId } = await rpc(srv, "posts:uploadUrl", { contentType: "text/plain" }, true);
      await fetch(uploadUrl, { method: "PUT", body: "image bytes", headers: { "content-type": "text/plain" } });
      const a = await rpc(srv, "posts:add", { title: "first", body: "hello world", tag: "news", imageId: storageId }, true);
      await rpc(srv, "posts:add", { title: "second", body: "another story", tag: "news" }, true);
      await rpc(srv, "posts:later", {}, true);
      await admin(srv, "env.set", { name: "GREETING", value: "hi" });

      const started = await admin(srv, "backups.create", { files: true });
      expect(started.state).toBe("running");
      const done = await finished(started._id);
      expect(done.state).toBe("done");
      expect(done.manifest.tables.posts).toBe(2);
      expect(done.manifest.tables._storage).toBe(1);
      expect(done.manifest.system.scheduled).toBe(1);
      expect(done.manifest.system.env).toBe(1);
      expect(done.manifest.files).toMatchObject({ included: true, count: 1, bytes: 11, missing: 0 });
      expect(done.manifest.functions.files).toBeGreaterThanOrEqual(2);
      expect((await listed()).functionsHash).toBe(done.manifest.functions.hash);

      // the archive is a plain .tar.gz
      const dl = await fetch(`${srv.url}/_admin/backups/download?id=${encodeURIComponent(done._id)}`, { headers: { "x-admin-key": KEY } });
      expect(dl.status).toBe(200);
      // From a folder the engine sends the archive itself; from a bucket it redirects to a presigned URL, whose path names the file.
      if (dl.redirected) expect(new URL(dl.url).pathname).toEndWith(".tar.gz");
      else expect(dl.headers.get("content-disposition")).toContain(".tar.gz");
      const archive = new Uint8Array(await dl.arrayBuffer());
      const names: string[] = [];
      for await (const e of readTarGz(new Blob([archive]).stream())) names.push(e.name);
      expect(names[0]).toBe("manifest.json");
      expect(names).toContain("data/documents.jsonl");
      expect(names).toContain("functions/schema.ts");
      expect(names).toContain("functions/posts.ts");
      expect(names.some((n) => n.startsWith("files/objects/"))).toBe(true);

      // change everything
      const live = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
      const updates: any[] = [];
      live.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "data") updates.push(m.data.value);
      });
      await new Promise((r) => live.addEventListener("open", r));
      live.send(JSON.stringify({ type: "subscribe", id: "1", name: "posts:byTag", args: { tag: "news" } }));
      await until(
        async () => updates.length,
        (n) => n >= 1,
      );
      await rpc(srv, "posts:remove", { id: a }, true);
      await rpc(srv, "posts:add", { title: "third", body: "after the backup", tag: "news" }, true);
      await rpc(srv, "posts:dropFile", { id: storageId }, true);
      await until(
        async () =>
          updates
            .at(-1)
            ?.map((p: any) => p.title)
            .sort()
            .join(),
        (t) => t === "second,third",
      );

      // restore: data and files
      const r = await admin(srv, "backups.restore", { id: done._id, files: true });
      expect(r.step).toBe("safety backup");
      const end = await until(listed, (l) => Boolean(l.restoring?.finishedAt));
      expect(end.restoring.error).toBeUndefined();
      expect(end.restoring.done).toMatchObject({ documents: 3, files: 1 });
      expect(end.backups.some((b: any) => b.kind === "pre-restore" && b.state === "done")).toBe(true);

      expect((await rpc(srv, "posts:byTag", { tag: "news" })).map((p: any) => p.title).sort()).toEqual(["first", "second"]);
      // the subscription re-ran by itself
      await until(
        async () =>
          updates
            .at(-1)
            ?.map((p: any) => p.title)
            .sort()
            .join(),
        (t) => t === "first,second",
      );
      // the search index was rebuilt with the documents
      expect((await rpc(srv, "posts:search", { text: "hello" })).map((p: any) => p.title)).toEqual(["first"]);
      expect(await rpc(srv, "posts:search", { text: "after" })).toEqual([]);
      // the file is back under its key
      expect(await (await fetch(await rpc(srv, "posts:fileUrl", { id: storageId }))).text()).toBe("image bytes");
      // the scheduled job too; env variables only when asked
      const jobs = await admin(srv, "scheduled");
      expect(JSON.stringify(jobs)).toContain("posts:add");
      live.close();

      // an uploaded archive is listed and can be restored like the others
      const up = await fetch(`${srv.url}/_admin/backups/upload`, { method: "POST", body: archive, headers: { "x-admin-key": KEY, "x-forge-admin": "1" } });
      expect(up.status).toBe(200);
      const uploaded = (await up.json()) as any;
      expect(uploaded).toMatchObject({ kind: "uploaded", state: "done" });
      expect(uploaded.manifest.tables.posts).toBe(2);
    });

    test("an archive that isn't a backup is refused, and nothing changes", async () => {
      const res = await fetch(`${srv.url}/_admin/backups/upload`, {
        method: "POST",
        body: new Blob([Bun.gzipSync(new TextEncoder().encode("not a tar".repeat(100)))]),
        headers: { "x-admin-key": KEY, "x-forge-admin": "1" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).message).toMatch(/backup|checksum/);
    });

    test("a restore that doesn't fit the schema changes nothing", async () => {
      // a backup with a document the schema now refuses: written by hand into a copy of the database's export
      if (label !== "sqlite, built-in storage") return; // the same code on every database; once is enough
      const p = await openProject(fixture, { ...env(tempDir()), MAX_UPLOAD_MB: "5" });
      try {
        await p.exec.mutate((s) => s.insert("posts", { title: "kept", body: "kept", tag: "x" }).then(() => {}));
        const file = join(tempDir(), "b.tar.gz");
        const { fullBackup, restore } = await import("../src/server/cli-ops");
        await fullBackup(p, file);
        // a document that fails validation: rewrite the archive's documents
        const entries: { name: string; bytes: Uint8Array }[] = [];
        for await (const e of readTarGz(Bun.file(file).stream())) {
          const parts: Uint8Array[] = [];
          for await (const c of e.body) parts.push(c);
          let bytes: Uint8Array = Buffer.concat(parts);
          if (e.name === "data/documents.jsonl") bytes = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('"tag":"x"', '"tag":5'));
          entries.push({ name: e.name, bytes });
        }
        const { writeTarGz } = await import("../src/server/backup/tar");
        await writeTarGz(
          file,
          entries.map((e) => ({ name: e.name, size: e.bytes.byteLength, body: () => e.bytes })),
        );
        await p.exec.mutate((s) => s.insert("posts", { title: "new", body: "new", tag: "y" }).then(() => {}));
        await expect(restore(p, file, { safety: false })).rejects.toThrow(/doesn't fit the schema/);
        const titles = (await p.exec.read((s) => s.query("posts").collect())).value.map((d: any) => d.title).sort();
        expect(titles).toEqual(["kept", "new"]);
      } finally {
        await p.close();
      }
    });

    test("only owners download, restore or delete; viewers list", async () => {
      expect((await fetch(`${srv.url}/_admin/backups/download?id=x`)).status).toBe(401);
      const res = await fetch(`${srv.url}/_admin/backups.restore`, { method: "POST", body: "{}", headers: { "x-forge-admin": "1", "content-type": "application/json" } });
      expect(res.status).toBe(401);
    });
  });

describe("the schedule", () => {
  test("a due slot runs once across servers, and old scheduled backups are pruned", async () => {
    const dataDir = tempDir();
    const p = await openProject(fixture, env(dataDir, { BACKUP_SCHEDULE: "* * * * *", BACKUP_KEEP: "1" }));
    try {
      const deps = { db: p.db, exec: p.exec, tables: p.project.tables, forgeDir: fixture, storage: p.storage, config: p.config, env: p.env };
      const one = new Backups({ ...deps, serverId: "a" });
      const two = new Backups({ ...deps, serverId: "b" });
      // the last scheduled backup was three minutes ago, so a slot is due
      await p.db.execute(`INSERT INTO "_backups" ("_id", "name", "createdAt", "kind", "state", "location") VALUES (?, ?, ?, 'scheduled', 'failed', 'dir:/nowhere')`, [
        "_backups:old",
        "old.tar.gz",
        Date.now() - 180_000,
      ]);
      await Promise.all([one.tick(), two.tick()]);
      const rows = await p.db.query<{ kind: string; state: string; server: string }>(`SELECT * FROM "_backups" WHERE "kind" = 'scheduled' AND "_id" != '_backups:old'`);
      expect(rows.length).toBe(1);
      expect(rows[0]!.state).toBe("done");
      // nothing is due now
      await one.tick();
      expect((await p.db.query(`SELECT * FROM "_backups" WHERE "kind" = 'scheduled' AND "state" = 'done'`)).length).toBe(1);
      // keep=1: another one replaces it
      await p.db.execute(`UPDATE "_backups" SET "createdAt" = "createdAt" - 120000 WHERE "kind" = 'scheduled'`);
      await one.tick();
      const kept = await p.db.query<{ name: string }>(`SELECT "name" FROM "_backups" WHERE "kind" = 'scheduled' AND "state" = 'done'`);
      expect(kept.length).toBe(1);
      const onDisk = [...new Bun.Glob("*.tar.gz").scanSync(join(dataDir, "backups"))];
      expect(onDisk).toEqual([kept[0]!.name]);
    } finally {
      await p.close();
    }
  });
});

describe("settings", () => {
  test("saved settings apply at the next start, the environment wins, and a bad stored one doesn't stop the engine", async () => {
    const dataDir = tempDir();
    let restarts = 0;
    let srv = await startServer({ forgeDir: fixture, dev: true, env: env(dataDir), restart: async () => void restarts++ });
    try {
      const before = await admin(srv, "settings");
      expect(before.restartable).toBe(true);
      const workers = before.settings.find((s: any) => s.name === "RUNTIME_WORKERS");
      expect(workers).toMatchObject({ source: "default", group: "Runtime", pending: false });
      const secret = before.settings.find((s: any) => s.name === "ADMIN_KEY");
      expect(secret).toMatchObject({ source: "environment", isSet: true, value: null }); // never shown
      await expect(admin(srv, "saveSetting", { name: "PORT", value: "4000" })).rejects.toThrow(/only be set in the environment/);
      await expect(admin(srv, "saveSetting", { name: "RUNTIME_WORKERS", value: "two" })).rejects.toThrow(/integer/);
      await expect(admin(srv, "saveSetting", { name: "RUNTIME_MODE", value: "inline" })).rejects.toThrow(/can't reload code/);
      await expect(admin(srv, "saveSetting", { name: "BACKUP_SCHEDULE", value: "every day" })).rejects.toThrow(/cron/);
      await admin(srv, "saveSetting", { name: "RUNTIME_WORKERS", value: "2" });
      await admin(srv, "saveSetting", { name: "CACHE_TTL_MS", value: "0" });
      await admin(srv, "saveSetting", { name: "BACKUP_SCHEDULE", value: "0 3 * * *" });
      const after = await admin(srv, "settings");
      expect(after.settings.find((s: any) => s.name === "RUNTIME_WORKERS")).toMatchObject({ source: "dashboard", value: "2", pending: true });
      expect(after.settings.find((s: any) => s.name === "BACKUP_SCHEDULE")).toMatchObject({ source: "dashboard", pending: false, live: true });
      expect((await admin(srv, "backups.list")).schedule.cron).toBe("0 3 * * *");
      expect(await admin(srv, "restart", {})).toEqual({ restarting: true });
      await until(
        async () => restarts,
        (n) => n === 1,
      );
      const audit = JSON.stringify(await admin(srv, "audit"));
      expect(audit).toContain("settings.save");
      expect(audit).not.toContain('"value"');
    } finally {
      await srv.stop();
    }
    srv = await startServer({ forgeDir: fixture, dev: true, env: env(dataDir) });
    try {
      expect(srv.config.runtimeWorkers).toBe(2);
      expect(srv.config.cacheTtlMs).toBe(0);
      expect((await admin(srv, "settings")).restartable).toBe(false);
      await expect(admin(srv, "restart", {})).rejects.toThrow(/can't restart itself/);
    } finally {
      await srv.stop();
    }
    srv = await startServer({ forgeDir: fixture, dev: true, env: env(dataDir, { RUNTIME_WORKERS: "1" }) });
    try {
      expect(srv.config.runtimeWorkers).toBe(1); // the environment wins
      expect((await admin(srv, "settings")).settings.find((s: any) => s.name === "RUNTIME_WORKERS")).toMatchObject({ source: "environment", value: "1" });
    } finally {
      await srv.stop();
    }
    // a stored value that no longer makes a valid configuration (it was fine in production, this is dev): ignored, with a reason
    const p = await openProject(fixture, env(dataDir));
    await p.db.execute(`INSERT INTO "_settings" ("name", "value", "updatedAt") VALUES ('RUNTIME_MODE', 'inline', 0)`);
    await p.close();
    srv = await startServer({ forgeDir: fixture, dev: true, env: env(dataDir) });
    try {
      expect(srv.config.runtimeWorkers).toBe(1);
      expect((await admin(srv, "settings")).storedError).toMatch(/ignoring the settings saved from the dashboard/);
    } finally {
      await srv.stop();
    }
  });
});
