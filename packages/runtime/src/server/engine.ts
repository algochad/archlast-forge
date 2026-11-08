// Which HTTP server answers: Bun.serve, or the native engine (@archlast/forge-serve: Rust I/O threads, the handlers still on Bun's thread).
//
// The engine is chosen by HTTP_ENGINE: `bun`, `archlast`, or `auto`, which takes the engine in production on a machine with 4 or more cores
// (serverCores(): the container's CPU quota when it has one) and only when it is built and loadable, else Bun.serve. One core gets nothing
// from threads, and development keeps the server it has always had. `archlast` asked for explicitly and not available is an error, not a
// quiet fallback.
//
// The engine is a workspace package that is not published: it sits next to this one in a checkout and in the engine image, which builds its
// native library. Anywhere it isn't (the npm package of the runtime), loading it fails and Bun.serve answers.
import { existsSync } from "node:fs";
import type { Server } from "bun";
import { serverCores, type Config } from "./config";

export type EngineName = "bun" | "archlast";

export interface NativeEngine {
  /** A Bun.serve-shaped server (see packages/serve/src/compat.ts). */
  serve: (options: any) => any;
  /** The engine's own response type: a body and head the native side writes without going through Web `Response` objects. */
  Reply: new (body: string | Uint8Array | null, init?: { status?: number; headers?: Record<string, string> | [string, string][] }) => unknown;
  /** A page the engine prints from a template and JSON data (see packages/serve/src/templates.ts). */
  TemplateReply: new (template: number, data: string, init?: { status?: number; headers?: [string, string][] }) => unknown;
}

let loading: Promise<NativeEngine | null> | undefined;

/** The native engine, or null where it is missing (not Linux, not built, not shipped). Loaded once. */
export function nativeEngine(): Promise<NativeEngine | null> {
  loading ??= (async () => {
    if (process.platform !== "linux") return null;
    try {
      const root = new URL("../../../serve/", import.meta.url);
      if (!existsSync(new URL("native/archlast_serve.node", root))) return null;
      // The paths are built at run time so the runtime's own build does not try to bundle a package that is not part of it.
      const compat = await import(new URL("src/compat.ts", root).href);
      const index = await import(new URL("src/index.ts", root).href);
      return { serve: compat.serveCompat, Reply: index.Reply, TemplateReply: index.TemplateReply } as NativeEngine;
    } catch {
      return null;
    }
  })();
  return loading;
}

/** What `choice` comes to on this machine: the engine that will answer, and why. Throws only for `archlast` that cannot be had. */
export async function chooseEngine(choice: Config["httpEngine"], dev: boolean): Promise<{ engine: EngineName; why: string }> {
  if (choice === "bun") return { engine: "bun", why: "HTTP_ENGINE=bun" };
  const native = await nativeEngine();
  if (choice === "archlast") {
    if (!native) throw new Error("HTTP_ENGINE=archlast, but the native engine is not available here (Linux, built with `bun run build` in packages/serve, or the engine image)");
    return { engine: "archlast", why: "HTTP_ENGINE=archlast" };
  }
  if (dev) return { engine: "bun", why: "development" };
  if (!native) return { engine: "bun", why: "the native engine is not available here" };
  const cores = serverCores();
  if (cores < 4) return { engine: "bun", why: `${cores} CPU core${cores === 1 ? "" : "s"}: threads would not help` };
  return { engine: "archlast", why: `${cores} CPU cores` };
}

/** Starts the server on the engine `chooseEngine` picked. Returns it as a Bun.serve server (the native one is a facade of that shape). */
export async function startHttpServer<T>(choice: Config["httpEngine"], dev: boolean, options: Parameters<typeof Bun.serve<T>>[0]): Promise<{ server: Server<T>; engine: EngineName; why: string }> {
  const { engine, why } = await chooseEngine(choice, dev);
  if (engine === "archlast") {
    const native = (await nativeEngine())!;
    return { server: native.serve(options) as Server<T>, engine, why };
  }
  return { server: Bun.serve<T>(options as any), engine, why };
}
