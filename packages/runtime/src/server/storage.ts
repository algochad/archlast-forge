import { S3Client } from "bun";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, S3Config } from "./config";

export interface Storage {
  putPresignedUrl(key: string, opts?: { contentType?: string; expiresIn?: number }): string;
  getPresignedUrl(key: string, opts?: { expiresIn?: number }): string;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ size: number; type?: string; lastModified?: Date }>;
  /** The object's bytes, for backups. */
  read(key: string): Blob;
  /** Writes an object, for restores. */
  write(key: string, data: Blob, contentType?: string): Promise<void>;
}

/** S3-compatible storage (AWS, RustFS, MinIO). Presigning is local, so it's safe inside queries. */
export class S3Storage implements Storage {
  private s3: S3Client;
  /** Signs the URLs handed to browsers, which may reach storage at a different address than the engine does. */
  private publicS3: S3Client;

  constructor(opts: S3Config) {
    const { publicEndpoint, ...s3 } = opts;
    this.s3 = new S3Client(s3);
    this.publicS3 = publicEndpoint ? new S3Client({ ...s3, endpoint: publicEndpoint }) : this.s3;
  }

  putPresignedUrl(key: string, { contentType, expiresIn = 3600 }: { contentType?: string; expiresIn?: number } = {}) {
    return this.publicS3.presign(key, { method: "PUT", expiresIn, type: contentType });
  }

  getPresignedUrl(key: string, { expiresIn = 3600 } = {}) {
    return this.publicS3.presign(key, { method: "GET", expiresIn });
  }

  async delete(key: string) {
    await this.s3.delete(key);
  }

  stat(key: string) {
    return this.s3.file(key).stat();
  }

  read(key: string): Blob {
    return this.s3.file(key);
  }

  async write(key: string, data: Blob, contentType?: string) {
    await this.s3.write(key, data, contentType ? { type: contentType } : {});
  }
}

/** Object names the built-in storage accepts: what `generateUploadUrl` makes (UUIDs), and nothing that could leave its directory. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const validKey = (key: string) => KEY.test(key);

/**
 * Storage on the engine's own disk, for development and single-server deployments without S3. Objects are files in `dir/objects`, their
 * content types in `dir/meta`; the engine serves them at /_storage/<key> with URLs it signs itself, so they work like presigned S3 URLs.
 */
export class LocalStorage implements Storage {
  readonly dir: string;
  private secret: Buffer;
  private publicUrl: string;

  constructor(opts: { dir: string; publicUrl: string; secret: string }) {
    this.dir = opts.dir;
    this.publicUrl = opts.publicUrl;
    this.secret = createHmac("sha256", opts.secret).update("archlast-forge storage v1").digest();
    mkdirSync(join(this.dir, "objects"), { recursive: true });
    mkdirSync(join(this.dir, "meta"), { recursive: true });
  }

  private path(key: string) {
    if (!validKey(key)) throw new Error(`Not a storage key: ${JSON.stringify(key)}`);
    return join(this.dir, "objects", key);
  }

  private metaPath(key: string) {
    return join(this.dir, "meta", key);
  }

  /** Signs method, key and expiry; the host is left out, so a URL works through any address that reaches the engine. */
  sign(method: "GET" | "PUT", key: string, expires: number) {
    return createHmac("sha256", this.secret).update(`${method}\n${key}\n${expires}`).digest("base64url");
  }

  verify(method: "GET" | "PUT", key: string, expires: string | null, sig: string | null) {
    const at = Number(expires);
    if (!sig || !Number.isInteger(at) || at < Date.now() / 1000) return false;
    const want = Buffer.from(this.sign(method, key, at));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private url(method: "GET" | "PUT", key: string, expiresIn: number) {
    this.path(key);
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    return `${this.publicUrl}/_storage/${encodeURIComponent(key)}?expires=${expires}&sig=${this.sign(method, key, expires)}`;
  }

  putPresignedUrl(key: string, { expiresIn = 3600 }: { contentType?: string; expiresIn?: number } = {}) {
    return this.url("PUT", key, expiresIn);
  }

  getPresignedUrl(key: string, { expiresIn = 3600 } = {}) {
    return this.url("GET", key, expiresIn);
  }

  async delete(key: string) {
    rmSync(this.path(key), { force: true });
    rmSync(this.metaPath(key), { force: true });
  }

  async stat(key: string) {
    const s = statSync(this.path(key), { throwIfNoEntry: false });
    if (!s) throw new Error(`No object ${key}`);
    return { size: s.size, type: this.typeOf(key), lastModified: s.mtime };
  }

  typeOf(key: string) {
    try {
      return readFileSync(this.metaPath(key), "utf8") || undefined;
    } catch {
      return undefined;
    }
  }

  read(key: string): Blob {
    return Bun.file(this.path(key));
  }

  async write(key: string, data: Blob, contentType?: string) {
    const tmp = join(this.dir, "objects", `.tmp-${crypto.randomUUID()}`);
    await Bun.write(tmp, data);
    this.commit(tmp, key, contentType);
  }

  /** Moves a fully written temporary file into place, so a reader never sees half an object. */
  commit(tmp: string, key: string, contentType?: string) {
    if (contentType) writeFileSync(this.metaPath(key), contentType);
    else rmSync(this.metaPath(key), { force: true });
    renameSync(tmp, this.path(key));
  }

  exists(key: string) {
    return existsSync(this.path(key));
  }
}

/**
 * The key the built-in storage signs URLs with. The server and every function runtime need the same one: derived from BETTER_AUTH_SECRET
 * (always set outside dev), otherwise a random key kept next to the files.
 */
function storageSecret(config: Pick<Config, "authSecret">, dir: string) {
  if (config.authSecret) return config.authSecret;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ".key");
  try {
    writeFileSync(file, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch {} // another process made it first
  return readFileSync(file, "utf8");
}

export const localStorageDir = (config: Pick<Config, "dataDir">) => join(config.dataDir, "storage");

export function createStorage(config: Pick<Config, "storage" | "s3" | "dataDir" | "authSecret" | "storagePublicUrl">): Storage | undefined {
  if (config.storage === "s3" && config.s3) return new S3Storage(config.s3);
  if (config.storage === "local") {
    const dir = localStorageDir(config);
    return new LocalStorage({ dir, publicUrl: config.storagePublicUrl, secret: storageSecret(config, dir) });
  }
  return undefined;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, PUT", "access-control-allow-headers": "content-type", "access-control-max-age": "3000" };
// Files are served from the app's own origin, so an uploaded HTML or SVG page must not run as the app: a sandboxed document has no origin of its own.
const SAFE = { "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" };
const fail = (status: number, message: string) => Response.json({ message }, { status, headers: CORS });

/** Answers /_storage/<key>: a signed PUT stores the body, a signed GET or HEAD serves the object (with Range support for media). */
export async function serveLocalStorage(req: Request, storage: LocalStorage, maxBytes: number): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice("/_storage/".length));
  } catch {
    return fail(400, "Malformed key");
  }
  if (!validKey(key)) return fail(404, "Not found");
  const method = req.method === "PUT" ? "PUT" : req.method === "GET" || req.method === "HEAD" ? "GET" : null;
  if (!method) return fail(405, "Use GET, HEAD or PUT");
  if (!storage.verify(method, key, url.searchParams.get("expires"), url.searchParams.get("sig"))) return fail(403, "The signature doesn't match, or the URL has expired");

  if (method === "PUT") {
    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (declared > maxBytes) return fail(413, `Files over ${Math.round(maxBytes / 2 ** 20)} MB aren't accepted (MAX_UPLOAD_MB)`);
    const tmp = join(storage.dir, "objects", `.tmp-${crypto.randomUUID()}`);
    const sink = Bun.file(tmp).writer();
    let size = 0;
    try {
      if (req.body)
        for await (const chunk of req.body) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new RangeError("too large");
          sink.write(chunk);
        }
      await sink.end();
      storage.commit(tmp, key, req.headers.get("content-type")?.split(";")[0]?.trim() || undefined);
      return new Response(null, { status: 200, headers: CORS });
    } catch (e) {
      await Promise.resolve(sink.end()).catch(() => {});
      rmSync(tmp, { force: true });
      if (e instanceof RangeError) return fail(413, `Files over ${Math.round(maxBytes / 2 ** 20)} MB aren't accepted (MAX_UPLOAD_MB)`);
      throw e;
    }
  }

  const file = storage.read(key) as ReturnType<typeof Bun.file>;
  const info = statSync(join(storage.dir, "objects", key), { throwIfNoEntry: false });
  if (!info) return fail(404, "No such object");
  const expires = Number(url.searchParams.get("expires"));
  const headers: Record<string, string> = {
    ...CORS,
    ...SAFE,
    "content-type": storage.typeOf(key) ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
    etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
    "cache-control": `private, max-age=${Math.max(0, Math.floor(expires - Date.now() / 1000))}`,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${info.size}` } });
    headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
    headers["content-length"] = String(end - start + 1);
    return new Response(req.method === "HEAD" ? null : file.slice(start, end + 1), { status: 206, headers });
  }
  headers["content-length"] = String(info.size);
  return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
}
