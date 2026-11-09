import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TlsEntry } from "./codec.ts";

type Pem = string | Uint8Array | Blob | (string | Uint8Array | Blob)[];

/** Bun.serve-style TLS options. Only PEM material is supported. */
export interface TlsOptions {
  /** PEM private key(s): string, Buffer, `Bun.file(...)` or an array of those. */
  key?: Pem;
  /** PEM certificate chain: string, Buffer, `Bun.file(...)` or an array of those (leaf first). */
  cert?: Pem;
  /** PEM CA certificate(s) used to verify client certificates (mutual TLS). */
  ca?: Pem;
  /** Server name this entry answers for (SNI); `*.example.com` wildcards work. The first entry is the default. */
  serverName?: string;
  /** Ask clients for a certificate. */
  requestCert?: boolean;
  /** With `requestCert`, refuse clients whose certificate does not verify (default true, as in Bun). */
  rejectUnauthorized?: boolean;
  /** Paths to PEM files, read when the server starts (the same as passing the contents): a path or an array of paths. */
  keyFile?: string | string[];
  certFile?: string | string[];
  caFile?: string | string[];
  /** Oldest and newest TLS version to negotiate (default: TLS 1.2 up to 1.3). */
  minVersion?: "TLSv1.2" | "TLSv1.3";
  maxVersion?: "TLSv1.2" | "TLSv1.3";
  /** Decrypts an encrypted private key (PKCS#8 or traditional PEM) when the server starts. Unencrypted keys are used as they are. */
  passphrase?: string;
  /** Accepted for compatibility, ignored. */
  secureOptions?: number;
  dhParamsFile?: string;
  lowMemoryMode?: boolean;
  ciphers?: string;
  ALPNProtocols?: unknown;
}

const decoder = new TextDecoder();

function pemText(v: Pem | undefined, what: string): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => pemText(x, what)).join("\n");
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return decoder.decode(v);
  // A BunFile: read it now, `listen` is synchronous.
  const path = (v as { name?: string }).name;
  if (!path)
    throw new TypeError(`tls.${what}: a Blob must be a Bun.file(path)`);
  return readFileSync(path, "utf8");
}

const PRIVATE_KEY =
  /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;

/** The keys of `pem` as unencrypted PKCS#8 PEM, when a passphrase says some are encrypted (rustls reads only plain keys). */
function decrypt(
  pem: string,
  passphrase: string | undefined,
  entry: number,
): string {
  if (!passphrase || !pem) return pem;
  const keys = pem.match(PRIVATE_KEY) ?? [];
  if (keys.length === 0) return pem;
  return keys
    .map((k) => {
      try {
        return createPrivateKey({ key: k, passphrase })
          .export({ type: "pkcs8", format: "pem" })
          .toString();
      } catch (e) {
        throw new Error(
          `tls[${entry}].passphrase: the private key could not be decrypted (${(e as Error).message})`,
        );
      }
    })
    .join("\n");
}

export function tlsEntries(
  tls: TlsOptions | TlsOptions[] | undefined,
): TlsEntry[] {
  if (!tls) return [];
  const list = Array.isArray(tls) ? tls : [tls];
  return list.map((t, i) => {
    const files = (v: string | string[] | undefined) =>
      v === undefined
        ? ""
        : (Array.isArray(v) ? v : [v])
            .map((f) => readFileSync(f, "utf8"))
            .join("\n");
    const cert = pemText(t.cert, "cert") || files(t.certFile);
    const key = decrypt(
      pemText(t.key, "key") || files(t.keyFile),
      t.passphrase,
      i,
    );
    if (!cert || !key)
      throw new TypeError(`tls[${i}]: both \`cert\` and \`key\` are required`);
    const requestCert = t.requestCert ?? false;
    return {
      cert,
      key,
      serverName: t.serverName ?? "",
      ca: pemText(t.ca, "ca") || files(t.caFile),
      requestCert,
      rejectUnauthorized: t.rejectUnauthorized ?? true,
      noTls12: t.minVersion === "TLSv1.3",
      noTls13: t.maxVersion === "TLSv1.2",
    };
  });
}
