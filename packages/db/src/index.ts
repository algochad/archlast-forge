// The native database layer (Rust, rusqlite): where its library is. The runtime loads it itself (packages/runtime/src/server/db/native.ts, which also has the types of
// what it offers); this is for the package's own tests and tools.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The built library, or null where it is not (not Linux, not built). */
export const library = ((file) => (process.platform === "linux" && existsSync(file) ? file : null))(join(import.meta.dir, "..", "native", "archlast_db.node"));
