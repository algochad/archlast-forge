// Backups: one .tar.gz with the documents, the scheduled jobs and migrations, the environment and settings, the forge/ source and the files in
// storage. Made and restored by the function runtime (it owns the database), kept wherever loadBackupConfig says, listed in `_backups`.
import { S3Client } from "bun";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ValidationError } from "../../values";
import { loadBackupConfig, type BackupConfig, type Config, type S3Config } from "../config";
import type { Db, DbTx } from "../db/types";
import type { TablesSpec } from "../docstore";
import type { Executor } from "../executor";
import { nextRun } from "../scheduler";
import { liveEnv } from "../settings";
import { validKey, type Storage } from "../storage";
import { readTarGz, writeTarGz, type TarEntry } from "./tar";

export const FORMAT = "archlast-forge-backup";

export type BackupKind = "manual" | "scheduled" | "pre-restore" | "uploaded" | "cli";

export interface BackupManifest {
  format: typeof FORMAT;
  version: 1;
  engine: string;
  createdAt: number;
  kind: BackupKind;
  dialect: "sqlite" | "postgres";
  release?: string;
  /** Documents in each table. */
  tables: Record<string, number>;
  system: { scheduled: number; migrations: number; env: number; settings: number };
  /** The forge/ source: a hash over every file, to tell whether the running code is the same. */
  functions: { files: number; bytes: number; hash: string };
  files: { included: boolean; count: number; bytes: number; missing: number };
}

export interface BackupRow {
  _id: string;
  name: string;
  createdAt: number;
  kind: BackupKind | "found";
  state: "running" | "done" | "failed" | "found";
  bytes: number | null;
  location: string;
  manifest: BackupManifest | null;
  progress: string | null;
  error: string | null;
  actor: string | null;
  finishedAt: number | null;
}

export interface BackupDeps {
  db: Db;
  exec: Executor;
  tables: TablesSpec;
  forgeDir: string;
  storage?: Storage;
  config: Config;
  /** The environment the engine started with: live BACKUP_* settings come from it, then from `_settings`. */
  env: Record<string, string | undefined>;
  serverId: string;
  release?: string;
}

/** The system tables a backup carries, and their columns: a restore writes only these, whatever an archive says. */
const SYSTEM = {
  scheduled: {
    table: "_scheduled_functions",
    file: "data/scheduled.jsonl",
    columns: ["_id", "_creationTime", "name", "args", "scheduledTime", "state", "error", "completedTime"],
    config: false,
  },
  migrations: { table: "_migrations", file: "data/migrations.jsonl", columns: ["name", "state", "cursor", "processed", "error", "updatedAt"], config: false },
  env: { table: "_env", file: "config/env.jsonl", columns: ["name", "value", "updatedAt"], config: true },
  settings: { table: "_settings", file: "config/settings.jsonl", columns: ["name", "value", "updatedAt", "updatedBy"], config: true },
} as const;

const engineVersion = (() => {
  let dir = import.meta.dir;
  for (let i = 0; i < 6; i++, dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@archlast/forge-runtime") return String(pkg.version);
    } catch {}
  }
  return "unknown";
})();

const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const stamp = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
const tmpRoot = (config: Config) => join(config.dataDir, ".backup-tmp");
const encoder = new TextEncoder();

// ---- where archives are kept ----

interface Store {
  /** Names the place, without credentials: what `_backups.location` records. */
  location: string;
  put(name: string, path: string): Promise<void>;
  read(name: string): Blob;
  delete(name: string): Promise<void>;
  /** A local path to serve, or a presigned URL to send the browser to. */
  download(name: string): { path: string } | { url: string };
  list(): Promise<{ name: string; size: number; lastModified: number }[]>;
}

const isArchive = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(name);

function dirStore(dir: string): Store {
  const root = resolve(dir);
  const path = (name: string) => {
    if (!isArchive(name)) throw new ValidationError(`Not a backup name: ${name}`);
    return join(root, name);
  };
  return {
    location: `dir:${root}`,
    async put(name, from) {
      mkdirSync(root, { recursive: true });
      try {
        renameSync(from, path(name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        copyFileSync(from, path(name)); // BACKUP_DIR on another file system than DATA_DIR
        rmSync(from, { force: true });
      }
    },
    read: (name) => Bun.file(path(name)),
    async delete(name) {
      rmSync(path(name), { force: true });
    },
    download: (name) => ({ path: path(name) }),
    async list() {
      if (!existsSync(root)) return [];
      return readdirSync(root)
        .filter(isArchive)
        .map((name) => {
          const s = statSync(join(root, name));
          return { name, size: s.size, lastModified: s.mtimeMs };
        });
    },
  };
}

function s3Store(s3: S3Config, prefix: string): Store {
  const { publicEndpoint, ...conn } = s3;
  const client = new S3Client(conn);
  const browser = publicEndpoint ? new S3Client({ ...conn, endpoint: publicEndpoint }) : client;
  const key = (name: string) => {
    if (!isArchive(name)) throw new ValidationError(`Not a backup name: ${name}`);
    return `${prefix}${name}`;
  };
  return {
    location: `s3:${s3.endpoint.replace(/\/+$/, "")}/${s3.bucket}/${prefix}`,
    async put(name, from) {
      await client.write(key(name), Bun.file(from), { type: "application/gzip" });
      rmSync(from, { force: true });
    },
    read: (name) => client.file(key(name)),
    async delete(name) {
      await client.delete(key(name));
    },
    download: (name) => ({ url: browser.presign(key(name), { expiresIn: 600, method: "GET" }) }),
    async list() {
      const out: { name: string; size: number; lastModified: number }[] = [];
      let token: string | undefined;
      do {
        const page = await client.list({ prefix, maxKeys: 1000, ...(token && { continuationToken: token }) });
        for (const o of page.contents ?? []) {
          const name = o.key.slice(prefix.length);
          if (isArchive(name)) out.push({ name, size: o.size ?? 0, lastModified: o.lastModified ? new Date(o.lastModified).getTime() : 0 });
        }
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}

const storeOf = (target: BackupConfig["target"]): Store => (target.kind === "s3" ? s3Store(target.s3, target.prefix) : dirStore(target.dir));

// ---- reading and writing the pieces ----

async function* lines(blob: Blob): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of blob.stream().pipeThrough(new TextDecoderStream())) {
    rest += chunk;
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (line) yield line;
    }
  }
  if (rest) yield rest;
}

/** The forge/ source, as it is deployed: no dependencies, data, dot files (secrets, .env) or anything over 10 MB. */
function sourceFiles(forgeDir: string): { path: string; rel: string; size: number }[] {
  const out: { path: string; rel: string; size: number }[] = [];
  if (!existsSync(forgeDir)) return out;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const path = join(dir, e.name);
      const rel = relative(forgeDir, path).split(sep).join("/");
      if (e.isDirectory()) {
        if (rel !== "data") walk(path);
      } else if (e.isFile()) {
        const size = statSync(path).size;
        if (size <= 10 * 2 ** 20) out.push({ path, rel, size });
      }
    }
  };
  walk(forgeDir);
  return out;
}

/** A hash of the forge/ source: the same code gives the same hash on any machine. */
export function sourceHash(forgeDir: string) {
  const h = new Bun.CryptoHasher("sha256");
  for (const f of sourceFiles(forgeDir)) h.update(`${f.rel}\0`).update(readFileSync(f.path)).update("\0");
  return h.digest("hex").slice(0, 16);
}

const docText = (doc: unknown) => (typeof doc === "string" ? doc : JSON.stringify(doc));

/**
 * Writes a backup archive at `path`. The documents and system rows come from one read transaction, so they are a consistent snapshot; files
 * are read after it, and a file deleted meanwhile is counted as missing.
 */
export async function writeArchive(d: BackupDeps, path: string, o: { kind: BackupKind; files: boolean; progress?: (text: string) => void }): Promise<BackupManifest> {
  mkdirSync(tmpRoot(d.config), { recursive: true });
  const tmp = mkdtempSync(join(tmpRoot(d.config), "make-"));
  try {
    const tables: Record<string, number> = {};
    const system = { scheduled: 0, migrations: 0, env: 0, settings: 0 };
    const objects: { key: string; type?: string }[] = [];
    let done = 0;
    await d.db.transaction("read", async (tx: DbTx) => {
      const docs = Bun.file(join(tmp, "documents.jsonl")).writer();
      for (const table of Object.keys(d.tables)) {
        tables[table] = 0;
        let after = "";
        for (;;) {
          const rows = await tx.query<{ _id: string; _creationTime: number; doc: unknown }>(
            `SELECT "_id", "_creationTime", "doc" FROM "${table}" WHERE "_id" > ? ORDER BY "_id" LIMIT 1000`,
            [after],
          );
          for (const r of rows) {
            const doc = docText(r.doc);
            docs.write(`{"table":${JSON.stringify(table)},"_id":${JSON.stringify(r._id)},"_creationTime":${Number(r._creationTime)},"doc":${doc}}\n`);
            if (table === "_storage") {
              const f = JSON.parse(doc) as { key?: string; contentType?: string };
              if (typeof f.key === "string") objects.push({ key: f.key, type: f.contentType });
            }
          }
          tables[table] += rows.length;
          done += rows.length;
          if (rows.length) o.progress?.(`${done} documents`);
          if (rows.length < 1000) break;
          after = rows.at(-1)!._id;
          await docs.flush();
        }
      }
      await docs.end();
      for (const [part, s] of Object.entries(SYSTEM) as [keyof typeof SYSTEM, (typeof SYSTEM)[keyof typeof SYSTEM]][]) {
        const rows = await tx.query<Record<string, unknown>>(`SELECT ${s.columns.map((c) => `"${c}"`).join(", ")} FROM "${s.table}"`);
        system[part] = rows.length;
        await Bun.write(join(tmp, s.file.replace("/", "-")), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
      }
    });

    const source = sourceFiles(d.forgeDir);
    const hash = new Bun.CryptoHasher("sha256");
    const sourceBytes = source.map((f) => {
      const bytes = readFileSync(f.path);
      hash.update(`${f.rel}\0`).update(bytes).update("\0");
      return bytes;
    });

    const files: { key: string; size: number; type?: string }[] = [];
    let missing = 0;
    if (o.files && d.storage) {
      for (const [i, obj] of objects.entries()) {
        const s = await d.storage.stat(obj.key).catch(() => null);
        if (s && validKey(obj.key)) files.push({ key: obj.key, size: s.size, type: obj.type ?? s.type });
        else missing++;
        if (i % 50 === 0) o.progress?.(`checking files ${i + 1}/${objects.length}`);
      }
    }
    const manifest: BackupManifest = {
      format: FORMAT,
      version: 1,
      engine: engineVersion,
      createdAt: Date.now(),
      kind: o.kind,
      dialect: d.db.dialect.name === "postgres" ? "postgres" : "sqlite",
      ...(d.release && { release: d.release }),
      tables,
      system,
      functions: { files: source.length, bytes: source.reduce((n, f) => n + f.size, 0), hash: hash.digest("hex").slice(0, 16) },
      files: { included: o.files && Boolean(d.storage), count: files.length, bytes: files.reduce((n, f) => n + f.size, 0), missing },
    };

    const blobEntry = (name: string, file: string): TarEntry => {
      const blob = Bun.file(file);
      return { name, size: blob.size, body: () => blob.stream() };
    };
    const bytesEntry = (name: string, bytes: Uint8Array): TarEntry => ({ name, size: bytes.byteLength, body: () => bytes });
    const storage = d.storage;
    let filesDone = 0;
    async function* entries(): AsyncGenerator<TarEntry> {
      yield bytesEntry("manifest.json", encoder.encode(JSON.stringify(manifest, null, 2)));
      yield blobEntry("data/documents.jsonl", join(tmp, "documents.jsonl"));
      for (const s of Object.values(SYSTEM)) yield blobEntry(s.file, join(tmp, s.file.replace("/", "-")));
      for (const [i, f] of source.entries()) yield bytesEntry(`functions/${f.rel}`, sourceBytes[i]!);
      if (manifest.files.included) {
        yield bytesEntry(
          "files/index.jsonl",
          encoder.encode(files.map((f) => JSON.stringify({ key: f.key, size: f.size, ...(f.type && { contentType: f.type }) })).join("\n") + (files.length ? "\n" : "")),
        );
        for (const f of files) {
          if (filesDone++ % 20 === 0) o.progress?.(`files ${filesDone}/${files.length}`);
          yield { name: `files/objects/${f.key}`, size: f.size, body: () => storage!.read(f.key).stream() };
        }
      }
    }
    o.progress?.("writing the archive");
    await writeTarGz(path, entries());
    return manifest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Unpacks what a restore needs into `dir` and returns the manifest. Archives that aren't backups are refused before anything is written. */
async function unpack(source: Blob, dir: string, wantFiles: boolean): Promise<BackupManifest> {
  let manifest: BackupManifest | undefined;
  for await (const entry of readTarGz(source.stream())) {
    if (entry.name === "manifest.json") {
      let text = "";
      for await (const c of entry.body) text += new TextDecoder().decode(c, { stream: true });
      manifest = JSON.parse(text);
      if (manifest?.format !== FORMAT) throw new ValidationError("This file isn't an archlast-forge backup");
      if (manifest.version !== 1) throw new ValidationError(`This backup has format version ${manifest.version}; this engine reads version 1. Restore it with a newer engine.`);
      continue;
    }
    if (!manifest) throw new ValidationError("This file isn't an archlast-forge backup (it doesn't start with manifest.json)");
    const objectKey = entry.name.startsWith("files/objects/") ? entry.name.slice("files/objects/".length) : undefined;
    const wanted =
      entry.name === "data/documents.jsonl" ||
      Object.values(SYSTEM).some((s) => s.file === entry.name) ||
      entry.name === "files/index.jsonl" ||
      (wantFiles && objectKey !== undefined && validKey(objectKey));
    if (!wanted) continue;
    const to = join(dir, objectKey !== undefined ? join("objects", objectKey) : entry.name.replace("/", "-"));
    mkdirSync(dirname(to), { recursive: true });
    const sink = Bun.file(to).writer();
    for await (const c of entry.body) sink.write(c);
    await sink.end();
  }
  if (!manifest) throw new ValidationError("This file isn't an archlast-forge backup");
  return manifest;
}

/** Just the manifest: the first entry, so this reads a few kilobytes of the archive. */
export async function readManifest(source: Blob): Promise<BackupManifest> {
  for await (const entry of readTarGz(source.stream())) {
    if (entry.name !== "manifest.json") break;
    let text = "";
    for await (const c of entry.body) text += new TextDecoder().decode(c, { stream: true });
    const m = JSON.parse(text) as BackupManifest;
    if (m.format === FORMAT) return m;
    break;
  }
  throw new ValidationError("This file isn't an archlast-forge backup");
}

export interface RestoreOptions {
  /** Put the files back in storage. */
  files: boolean;
  /** Replace the environment variables and the settings with the backup's. */
  config: boolean;
}

export interface RestoreResult {
  documents: number;
  files: number;
  tables: number;
  config: boolean;
  manifest: BackupManifest;
}

/**
 * Restores an archive: files first (a failure there leaves the data as it was), then every document table, the scheduled jobs and migration
 * states (and, if asked, the environment and settings) in one transaction, so the data is all the backup's or, if anything fails, all as it was.
 * Tables the schema has and the backup doesn't are emptied. Objects in storage that the backup doesn't have are left alone.
 */
export async function restoreArchive(d: BackupDeps, source: Blob, o: RestoreOptions, progress?: (text: string) => void): Promise<RestoreResult> {
  mkdirSync(tmpRoot(d.config), { recursive: true });
  const dir = mkdtempSync(join(tmpRoot(d.config), "restore-"));
  try {
    progress?.("unpacking");
    const manifest = await unpack(source, dir, o.files);
    for (const t of Object.keys(manifest.tables))
      if (!d.tables[t])
        throw new ValidationError(`The backup has a table "${t}" that the schema doesn't. Deploy the code it was made with (its forge/ source is in the archive), then restore.`);

    let files = 0;
    if (o.files && manifest.files.included && manifest.files.count) {
      if (!d.storage) throw new ValidationError("The backup has files, but storage is off here: set STORAGE (or S3_*) first, or restore without files");
      for await (const line of lines(Bun.file(join(dir, "files-index.jsonl")))) {
        const f = JSON.parse(line) as { key: string; contentType?: string };
        const path = join(dir, "objects", f.key);
        if (!validKey(f.key) || !existsSync(path)) continue;
        await d.storage.write(f.key, Bun.file(path), f.contentType);
        if (++files % 20 === 0) progress?.(`files ${files}/${manifest.files.count}`);
      }
    }

    progress?.("restoring documents");
    let documents = 0;
    await d.exec.rewrite(async (store, tx) => {
      for (const t of Object.keys(d.tables)) await store.truncate(t);
      let n = 0;
      for await (const line of lines(Bun.file(join(dir, "data-documents.jsonl")))) {
        n++;
        let r: { table: string; _id: string; _creationTime: number; doc: Record<string, unknown> };
        try {
          r = JSON.parse(line);
        } catch {
          throw new ValidationError(`Line ${n} of the backup's documents isn't valid JSON`);
        }
        if (!d.tables[r.table]) throw new ValidationError(`Line ${n} of the backup's documents is in table "${r.table}", which the schema doesn't have`);
        try {
          await store.restore(r.table, r._id, Number(r._creationTime), r.doc);
        } catch (e) {
          throw new ValidationError(`Document ${r._id} doesn't fit the schema: ${(e as Error).message}. Nothing was restored.`);
        }
        if (++documents % 5000 === 0) progress?.(`${documents} documents`);
      }
      for (const s of Object.values(SYSTEM)) {
        if (s.config && !o.config) continue;
        await tx.execute(`DELETE FROM "${s.table}"`);
        const cols = s.columns.map((c) => `"${c}"`).join(", ");
        const marks = s.columns.map(() => "?").join(", ");
        const file = Bun.file(join(dir, s.file.replace("/", "-")));
        if (!(await file.exists())) continue;
        for await (const line of lines(file)) {
          const row = JSON.parse(line) as Record<string, unknown>;
          await tx.execute(
            `INSERT INTO "${s.table}" (${cols}) VALUES (${marks})`,
            s.columns.map((c) => row[c] ?? null),
          );
        }
      }
    });
    return { documents, files, tables: Object.keys(manifest.tables).length, config: o.config, manifest };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the registry and the schedule ----

type Raw = Omit<BackupRow, "manifest"> & { manifest: string | null };
const parse = (r: Raw): BackupRow => ({
  ...r,
  createdAt: Number(r.createdAt),
  bytes: r.bytes === null ? null : Number(r.bytes),
  finishedAt: r.finishedAt === null ? null : Number(r.finishedAt),
  manifest: r.manifest ? JSON.parse(r.manifest) : null,
});

/** What the dashboard shows and does with backups. Lives in the function runtime's first process, next to the scheduler. */
export class Backups {
  private restoring: { id: string; startedAt: number; step: string; done?: RestoreResult; error?: string; finishedAt?: number } | null = null;
  private running = new Set<string>();
  /** The running code's hash: this process loaded the code once (a change restarts it). */
  private hash?: string;
  /** When this process first saw the current schedule, so a schedule set by the environment starts counting from startup. */
  private scheduleSeen?: { schedule: string; at: number };

  constructor(private d: BackupDeps) {}

  /** The backup settings now: the environment's, then the dashboard's. */
  async settings(): Promise<BackupConfig> {
    const rows = await this.d.db.query<{ name: string; value: string }>(`SELECT "name", "value" FROM "_settings" WHERE "name" LIKE 'BACKUP_%'`);
    const stored = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    return loadBackupConfig({ ...this.d.env, ...liveEnv(this.d.env, stored) }, this.d.config);
  }

  private async store() {
    return storeOf((await this.settings()).target);
  }

  /** The store a backup was written to: the current one, or a directory it was moved away from. */
  private async storeFor(row: Pick<BackupRow, "location">) {
    const current = await this.store();
    if (row.location === current.location) return current;
    if (row.location.startsWith("dir:")) return dirStore(row.location.slice(4));
    if (this.d.config.s3) {
      const files = s3Store(this.d.config.s3, "_backups/");
      if (row.location === files.location) return files;
    }
    throw new ValidationError(`This backup is in ${row.location}, which isn't where backups go now; point the backup settings back there to use it`);
  }

  /** Backups that were interrupted (the process running them stopped) are failed, not running forever. */
  async recover() {
    await this.d.db.execute(`UPDATE "_backups" SET "state" = 'failed', "error" = ?, "finishedAt" = ? WHERE "state" = 'running' AND "server" = ?`, [
      "Interrupted: the function runtime stopped while it ran",
      Date.now(),
      this.d.serverId,
    ]);
  }

  async row(id: string): Promise<BackupRow> {
    if (id.startsWith("found:")) {
      const name = id.slice("found:".length);
      const store = await this.store();
      const hit = (await store.list()).find((f) => f.name === name);
      if (!hit) throw new ValidationError(`No backup ${name}`);
      return {
        _id: id,
        name,
        createdAt: hit.lastModified,
        kind: "found",
        state: "found",
        bytes: hit.size,
        location: store.location,
        manifest: null,
        progress: null,
        error: null,
        actor: null,
        finishedAt: null,
      };
    }
    const [r] = await this.d.db.query<Raw>(`SELECT * FROM "_backups" WHERE "_id" = ?`, [id]);
    if (!r) throw new ValidationError(`No backup ${id}`);
    return parse(r);
  }

  async list() {
    const rows = (await this.d.db.query<Raw>(`SELECT * FROM "_backups" ORDER BY "createdAt" DESC LIMIT 500`)).map(parse);
    const cfg = await this.settings();
    const store = storeOf(cfg.target);
    // Archives in the store that this database doesn't know about: from before a restore of the database itself, or another deployment.
    const known = new Set(rows.filter((r) => r.location === store.location).map((r) => r.name));
    let found: BackupRow[] = [];
    let storeError: string | null = null;
    try {
      found = (await store.list())
        .filter((f) => !known.has(f.name))
        .map((f) => ({
          _id: `found:${f.name}`,
          name: f.name,
          createdAt: f.lastModified,
          kind: "found" as const,
          state: "found" as const,
          bytes: f.size,
          location: store.location,
          manifest: null,
          progress: null,
          error: null,
          actor: null,
          finishedAt: null,
        }));
    } catch (e) {
      storeError = (e as Error).message;
    }
    const seen = this.scheduleSeen?.schedule === cfg.schedule ? this.scheduleSeen.at : Date.now();
    const last = rows.find((r) => r.kind === "scheduled");
    return {
      backups: [...rows, ...found].sort((a, b) => b.createdAt - a.createdAt),
      target: { kind: cfg.target.kind, location: store.location },
      storeError,
      schedule: { cron: cfg.schedule, keep: cfg.keep, files: cfg.files, next: cfg.schedule ? nextRun({ kind: "cron", expression: cfg.schedule }, last?.createdAt ?? seen) : null },
      storage: Boolean(this.d.storage),
      functionsHash: (this.hash ??= sourceHash(this.d.forgeDir)),
      restoring: this.restoring,
    };
  }

  /** Starts a backup and returns its row at once; `done` settles when the archive is stored. */
  async start(o: { kind: BackupKind; files?: boolean; actor: string; id?: string }): Promise<{ row: BackupRow; done: Promise<BackupRow> }> {
    const cfg = await this.settings();
    const store = storeOf(cfg.target);
    const createdAt = Date.now();
    const id = o.id ?? `_backups:${newId()}`;
    const name = `backup-${stamp(createdAt)}-${o.kind}-${id.slice(-6).replace(/[^A-Za-z0-9]/g, "")}.tar.gz`;
    const files = o.files ?? cfg.files;
    const claim = crypto.randomUUID();
    // Scheduled backups have an id per slot: on several servers only the one whose insert lands runs it.
    await this.d.db.execute(
      `INSERT INTO "_backups" ("_id", "name", "createdAt", "kind", "state", "location", "progress", "actor", "server") VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT ("_id") DO NOTHING`,
      [id, name, createdAt, o.kind, store.location, claim, o.actor, this.d.serverId],
    );
    const row = await this.row(id);
    if (row.progress !== claim) throw new Claimed();
    this.running.add(id);
    let last = 0;
    const progress = (text: string) => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      void this.d.db.execute(`UPDATE "_backups" SET "progress" = ? WHERE "_id" = ? AND "state" = 'running'`, [text, id]).catch(() => {});
    };
    const done = (async () => {
      const tmp = join(tmpRoot(this.d.config), `${newId()}.tar.gz`);
      try {
        mkdirSync(tmpRoot(this.d.config), { recursive: true });
        const manifest = await writeArchive(this.d, tmp, { kind: o.kind, files, progress });
        const bytes = statSync(tmp).size;
        progress("storing the archive");
        await store.put(name, tmp);
        await this.d.db.execute(`UPDATE "_backups" SET "state" = 'done', "bytes" = ?, "manifest" = ?, "progress" = NULL, "finishedAt" = ? WHERE "_id" = ?`, [
          bytes,
          JSON.stringify(manifest),
          Date.now(),
          id,
        ]);
        if (o.kind === "scheduled") await this.prune(cfg.keep).catch((e) => console.error(`pruning backups failed: ${(e as Error).message}`));
      } catch (e) {
        await this.d.db.execute(`UPDATE "_backups" SET "state" = 'failed', "error" = ?, "progress" = NULL, "finishedAt" = ? WHERE "_id" = ?`, [(e as Error).message, Date.now(), id]);
      } finally {
        rmSync(tmp, { force: true });
        this.running.delete(id);
      }
      return this.row(id);
    })();
    return { row: { ...row, progress: null }, done };
  }

  /** Keeps the newest `keep` scheduled backups; older ones (and failed scheduled runs past the last ten) are deleted. */
  async prune(keep: number) {
    const rows = (await this.d.db.query<Raw>(`SELECT * FROM "_backups" WHERE "kind" = 'scheduled' ORDER BY "createdAt" DESC`)).map(parse);
    const done = rows.filter((r) => r.state === "done").slice(keep);
    const failed = rows.filter((r) => r.state === "failed").slice(10);
    for (const r of [...done, ...failed]) await this.remove(r._id);
  }

  async remove(id: string) {
    const row = await this.row(id);
    if (row.state === "running") throw new ValidationError("That backup is still running");
    if (row.state !== "failed") await (await this.storeFor(row)).delete(row.name);
    if (!id.startsWith("found:")) await this.d.db.execute(`DELETE FROM "_backups" WHERE "_id" = ?`, [id]);
  }

  async download(id: string) {
    const row = await this.row(id);
    if (row.state !== "done" && row.state !== "found") throw new ValidationError("Only a finished backup can be downloaded");
    return { name: row.name, ...(await this.storeFor(row)).download(row.name) };
  }

  /** An uploaded archive (the server saved it at `path`): checked, kept in the store, listed. */
  async importFile(path: string, actor: string): Promise<BackupRow> {
    try {
      const manifest = await readManifest(Bun.file(path));
      const store = await this.store();
      const createdAt = Date.now();
      const id = `_backups:${newId()}`;
      const name = `backup-${stamp(manifest.createdAt)}-uploaded-${id.slice(-6)}.tar.gz`;
      const bytes = statSync(path).size;
      await store.put(name, path);
      await this.d.db.execute(
        `INSERT INTO "_backups" ("_id", "name", "createdAt", "kind", "state", "bytes", "location", "manifest", "actor", "server", "finishedAt") VALUES (?, ?, ?, 'uploaded', 'done', ?, ?, ?, ?, ?, ?)`,
        [id, name, createdAt, bytes, store.location, JSON.stringify(manifest), actor, this.d.serverId, createdAt],
      );
      return this.row(id);
    } finally {
      rmSync(path, { force: true });
    }
  }

  /**
   * Restores a backup in the background: a safety backup of what is there now first (kind "pre-restore", with files when files are restored),
   * then the restore. `list()` reports how it went.
   */
  async restore(id: string, o: RestoreOptions & { actor: string }) {
    if (this.restoring && !this.restoring.finishedAt) throw new ValidationError("A restore is already running");
    const row = await this.row(id);
    if (row.state !== "done" && row.state !== "found") throw new ValidationError("Only a finished backup can be restored");
    const store = await this.storeFor(row);
    const state = (this.restoring = { id, startedAt: Date.now(), step: "safety backup" } as NonNullable<Backups["restoring"]>);
    const done = (async () => {
      try {
        const safety = await (await this.start({ kind: "pre-restore", files: o.files, actor: o.actor })).done;
        if (safety.state !== "done") throw new Error(`The safety backup failed, so nothing was restored: ${safety.error}`);
        state.done = await restoreArchive(this.d, store.read(row.name), o, (step) => (state.step = step));
        state.step = "done";
      } catch (e) {
        state.error = (e as Error).message;
        state.step = "failed";
      } finally {
        state.finishedAt = Date.now();
      }
      return state;
    })();
    return { started: state, done };
  }

  /** Runs the scheduled backup when its time has come. Called every half minute; a slot missed while the engine was down runs once. */
  async tick() {
    const cfg = await this.settings();
    if (!cfg.schedule) return (this.scheduleSeen = undefined);
    if (this.scheduleSeen?.schedule !== cfg.schedule) this.scheduleSeen = { schedule: cfg.schedule, at: Date.now() };
    if ([...this.running].some((id) => id.startsWith("_backups:scheduled-"))) return;
    const [last] = await this.d.db.query<{ at: number | null }>(`SELECT MAX("createdAt") AS "at" FROM "_backups" WHERE "kind" = 'scheduled'`);
    // From the last scheduled backup, so a slot missed while the engine was down runs now; with none yet, from when the schedule appeared.
    const from = last?.at != null ? Number(last.at) : this.scheduleSeen.at;
    const slot = nextRun({ kind: "cron", expression: cfg.schedule }, from);
    if (slot > Date.now()) return;
    try {
      const { done } = await this.start({ kind: "scheduled", actor: "schedule", id: `_backups:scheduled-${slot}` });
      const row = await done;
      if (row.state === "failed") console.error(`scheduled backup failed: ${row.error}`);
    } catch (e) {
      if (!(e instanceof Claimed)) throw e;
    }
  }
}

/** Another server took this scheduled backup. */
class Claimed extends Error {}
