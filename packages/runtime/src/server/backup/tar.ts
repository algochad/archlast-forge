// A streaming tar (POSIX ustar, with PAX headers for long names), gzipped: what `tar xzf` reads. Bun.Archive holds every entry in memory,
// and a backup with its files can be larger than that.

export interface TarEntry {
  name: string;
  size: number;
  /** The entry's bytes, exactly `size` of them. */
  body: () => AsyncIterable<Uint8Array> | Uint8Array;
  mtime?: number;
}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function octal(out: Uint8Array, offset: number, length: number, value: number) {
  const s = Math.floor(value)
    .toString(8)
    .padStart(length - 1, "0");
  if (s.length > length - 1) {
    // GNU base-256 for sizes past 8 GiB: a high bit, then the number big-endian.
    out[offset] = 0x80;
    let v = BigInt(Math.floor(value));
    for (let i = offset + length - 1; i > offset; i--, v >>= 8n) out[i] = Number(v & 0xffn);
    return;
  }
  out.set(encoder.encode(s), offset);
}

function header(name: Uint8Array, size: number, mtime: number, type: "0" | "x") {
  const h = new Uint8Array(BLOCK);
  h.set(name.subarray(0, 100), 0);
  octal(h, 100, 8, 0o644);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime / 1000);
  h.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  h[156] = type.charCodeAt(0);
  h.set(encoder.encode("ustar\u000000"), 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(encoder.encode(sum.toString(8).padStart(6, "0") + "\u0000 "), 148);
  return h;
}

/** A PAX record: "<length> path=<name>\n", where the length counts itself. */
function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  const base = encoder.encode(body).length;
  let len = base + String(base).length;
  if (String(len).length > String(base).length) len++; // adding the digits added a digit
  return encoder.encode(`${len}${body}`);
}

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

async function* tarStream(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Uint8Array> {
  for await (const e of entries) {
    const name = encoder.encode(e.name);
    const mtime = e.mtime ?? Date.now();
    if (name.length > 100) {
      const pax = paxRecord("path", e.name);
      yield header(encoder.encode("PaxHeader"), pax.length, mtime, "x");
      yield pax;
      yield padding(pax.length);
    }
    yield header(name, e.size, mtime, "0");
    let written = 0;
    const body = e.body();
    for await (const chunk of body instanceof Uint8Array ? [body] : body) {
      written += chunk.byteLength;
      if (written > e.size) throw new Error(`${e.name} grew while it was being archived`);
      yield chunk;
    }
    if (written !== e.size) throw new Error(`${e.name} is ${written} bytes, not the ${e.size} it had when the backup started`);
    yield padding(e.size);
  }
  yield new Uint8Array(BLOCK * 2);
}

/** Writes the entries, in order, as a .tar.gz at `path`. */
export async function writeTarGz(path: string, entries: AsyncIterable<TarEntry> | Iterable<TarEntry>) {
  const it = tarStream(entries);
  const tar = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await it.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await it.return(undefined);
    },
  });
  const stream = tar.pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  await Bun.write(path, new Response(stream));
}

/** Pulls exact byte counts out of a stream of chunks. */
class Pull {
  private chunks: Uint8Array[] = [];
  private held = 0;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number) {
    while (this.held < n) {
      const { done, value } = await this.reader.read();
      if (done) return false;
      this.chunks.push(value);
      this.held += value.byteLength;
    }
    return true;
  }

  /** Exactly n bytes, or null at the end of the stream. */
  async take(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) return null;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const use = Math.min(c.byteLength, n - at);
      out.set(c.subarray(0, use), at);
      at += use;
      if (use === c.byteLength) this.chunks.shift();
      else this.chunks[0] = c.subarray(use);
    }
    this.held -= n;
    return out;
  }

  /** The next n bytes as they arrive. */
  async *stream(n: number): AsyncGenerator<Uint8Array> {
    while (n > 0) {
      if (!this.held && !(await this.fill(1))) throw new Error("The archive ends in the middle of a file");
      const c = this.chunks[0]!;
      const use = Math.min(c.byteLength, n);
      if (use === c.byteLength) this.chunks.shift();
      else this.chunks[0] = c.subarray(use);
      this.held -= use;
      n -= use;
      yield c.subarray(0, use);
    }
  }

  async skip(n: number) {
    for await (const _ of this.stream(n));
  }
}

const field = (h: Uint8Array, offset: number, length: number) => {
  const s = h.subarray(offset, offset + length);
  const end = s.indexOf(0);
  return decoder.decode(end < 0 ? s : s.subarray(0, end));
};

function sizeOf(h: Uint8Array) {
  if (h[124]! & 0x80) {
    let v = 0n;
    for (let i = 125; i < 136; i++) v = (v << 8n) | BigInt(h[i]!);
    return Number(v);
  }
  return parseInt(field(h, 124, 12).trim() || "0", 8);
}

export interface TarFile {
  name: string;
  size: number;
  /** Read it before asking for the next entry; what is left unread is skipped. */
  body: AsyncIterable<Uint8Array>;
}

/** The regular files of a .tar.gz, one at a time. Directories, links and other entries are skipped. */
export async function* readTarGz(source: ReadableStream<Uint8Array>): AsyncGenerator<TarFile> {
  const pull = new Pull(source.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>).getReader());
  let longName: string | undefined;
  for (;;) {
    const h = await pull.take(BLOCK);
    if (!h || h.every((b) => b === 0)) return;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== parseInt(field(h, 148, 8).trim(), 8)) throw new Error("Not a backup archive (a tar header's checksum doesn't match)");
    const size = sizeOf(h);
    const type = String.fromCharCode(h[156]!);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === "x" || type === "L") {
      const body = (await pull.take(size)) ?? new Uint8Array(0);
      const text = decoder.decode(type === "L" ? body.subarray(0, body.indexOf(0) < 0 ? size : body.indexOf(0)) : body);
      longName = type === "L" ? text : /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1];
      await pull.skip(pad);
      continue;
    }
    const prefix = field(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    longName = undefined;
    if (type !== "0" && type !== "\u0000") {
      await pull.skip(size + pad);
      continue;
    }
    let left = size;
    const body = (async function* () {
      for await (const chunk of pull.stream(size)) {
        left -= chunk.byteLength;
        yield chunk;
      }
    })();
    yield { name, size, body };
    if (left > 0) await pull.skip(left);
    await pull.skip(pad);
  }
}
