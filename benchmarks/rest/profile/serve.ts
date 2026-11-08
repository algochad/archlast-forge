import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../packages/runtime/src/server/server";

const server = await startServer({
  forgeDir: join(import.meta.dir, "forge"),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: process.env.PORT ?? "4900",
    DATA_DIR: mkdtempSync(join(tmpdir(), "afx-prof-")),
    BETTER_AUTH_SECRET: "s".repeat(32),
    ALLOW_INSECURE_HTTP: "1",
    RATE_LIMIT_PER_MINUTE: "0",
    LOG_FORMAT: "json",
    LOG_LEVEL: "warn",
  },
});
console.log("ready", server.url);
// a profile is written when the process exits: leave on a signal so BUNARGS="--cpu-prof-md" produces one
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
