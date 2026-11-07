import type { NativeOptions } from "./codec.ts";

export type Compressor = "disable" | "shared" | "dedicated" | "3KB" | "4KB" | "8KB" | "16KB" | "32KB" | "64KB" | "128KB" | "256KB";

/** Bun.serve-style `perMessageDeflate`. */
export type PerMessageDeflate = boolean | { compress?: boolean | Compressor; decompress?: boolean | Compressor };

const WINDOW: Record<string, number> = { "3KB": 9, "4KB": 10, "8KB": 11, "16KB": 12, "32KB": 13, "64KB": 14, "128KB": 15, "256KB": 15, dedicated: 15 };

/**
 * `true` / `"shared"` deflate each message on its own (no context kept between messages: little memory per socket);
 * `"dedicated"` and the sizes keep a context per socket with that window (better ratio, more memory).
 * `decompress` only matters when both are disabled: the extension is offered whenever it is on, since a peer that
 * agrees to it may compress what it sends.
 */
export function deflateOptions(v: PerMessageDeflate | undefined): NativeOptions["wsDeflate"] {
    const off = { enabled: false, compress: false, noContextTakeover: false, windowBits: 15 };
    if (v === undefined || v === false) return off;
    const compress = v === true ? "shared" : (v.compress ?? true);
    const decompress = v === true ? true : (v.decompress ?? true);
    const compressOn = compress !== false && compress !== "disable";
    const decompressOn = decompress !== false && decompress !== "disable";
    if (!compressOn && !decompressOn) return off;
    const mode = compress === true ? "shared" : compress;
    const dedicated = compressOn && typeof mode === "string" && mode !== "shared" && mode in WINDOW;
    return { enabled: true, compress: compressOn, noContextTakeover: !dedicated, windowBits: dedicated ? WINDOW[mode as string] : 15 };
}
