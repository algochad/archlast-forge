// Starts the app's engine for the desktop app (Bun runs this file as the app's sidecar): production mode, on this machine only, with its
// data and a secret of its own in the app's data folder. Tauri passes PORT and DATA_DIR; this file is copied into the app's bundle.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = process.env.PORT ?? "3000";
const data = process.env.DATA_DIR ?? join(import.meta.dir, "data");
mkdirSync(data, { recursive: true });
// The secret that signs sessions: made on first start, kept with the data, readable only by this user.
const secretFile = join(data, "secret");
if (!existsSync(secretFile)) writeFileSync(secretFile, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), { mode: 0o600 });

const cli = join(import.meta.dir, "node_modules", "@archlast", "forge-cli", "src", "index.ts");
const engine = Bun.spawn([process.execPath, cli, "start", "--no-docker", "--dir", join(import.meta.dir, "forge"), "--port", port], {
  cwd: import.meta.dir,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    DATA_DIR: data,
    // Only this computer: the engine never listens on the network.
    HOST: "127.0.0.1",
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? readFileSync(secretFile, "utf8"),
    // http is fine on the loopback interface, which nothing else reaches.
    ALLOW_INSECURE_HTTP: "1",
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => engine.kill(signal));
process.exit(await engine.exited);
