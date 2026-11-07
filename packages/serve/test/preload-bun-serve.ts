// `bun test --preload <this file>` in another project: every `Bun.serve` call there is answered by archlast-serve's
// Bun.serve-shaped facade instead. Used to run a project's own test suite against this engine.
import { serveCompat } from "../src/compat.ts";

const backend =
  (process.env.ARCHLAST_BACKEND as "napi" | "bun-ffi" | undefined) ?? "napi";
(Bun as unknown as { serve: unknown }).serve = (
  opts: Parameters<typeof serveCompat>[0],
) => serveCompat({ backend, ...opts });
