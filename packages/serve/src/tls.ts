import { readFileSync } from "node:fs";
import type { TlsEntry } from "./codec.ts";

type Pem = string | Uint8Array | Blob | (string | Uint8Array | Blob)[];

/** Bun.serve-style TLS options. Only PEM material is supported (see `passphrase`). */
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
    /** Encrypted private keys are not supported: decrypt them first (`openssl pkey -in enc.pem -out key.pem`). */
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
    if (!path) throw new TypeError(`tls.${what}: a Blob must be a Bun.file(path)`);
    return readFileSync(path, "utf8");
}

export function tlsEntries(tls: TlsOptions | TlsOptions[] | undefined): TlsEntry[] {
    if (!tls) return [];
    const list = Array.isArray(tls) ? tls : [tls];
    return list.map((t, i) => {
        if (t.passphrase) throw new Error("tls.passphrase: encrypted private keys are not supported; decrypt the key to PEM first");
        const files = (v: string | string[] | undefined) => (v === undefined ? "" : (Array.isArray(v) ? v : [v]).map((f) => readFileSync(f, "utf8")).join("\n"));
        const cert = pemText(t.cert, "cert") || files(t.certFile);
        const key = pemText(t.key, "key") || files(t.keyFile);
        if (!cert || !key) throw new TypeError(`tls[${i}]: both \`cert\` and \`key\` are required`);
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
