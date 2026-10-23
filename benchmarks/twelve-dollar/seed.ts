// Loads the challenge's deterministic seed (50,000 users, 500,000 posts, ~2,000,000 likes) into an archlast-forge database,
// and creates a real Better Auth session for each of the first 20,000 users (the counterpart of the challenge's pre-signed JWTs).
//
//   bun benchmarks/twelve-dollar/seed.ts --challenge <clone of twelve-dollar-server-challenge> --out <dir> [--driver turso|bun]
//
// Writes <dir>/app.db (the engine's DATA_DIR, a Turso database) and <dir>/tokens.json: [{ id, username, cookie }].
// BETTER_AUTH_SECRET must be the same value the server runs with, because it signs the session cookies.
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLocalDb } from "../../packages/runtime/src/server/db/factory";
import { loadProject, tableSpecs } from "../../packages/runtime/src/server/project";
import { migrateSystem } from "../../packages/runtime/src/server/system";

const { values } = parseArgs({ options: { challenge: { type: "string" }, out: { type: "string" }, driver: { type: "string", default: "turso" } } });
const challenge = resolve(values.challenge ?? "");
const out = resolve(values.out ?? "");
const secret = process.env.BETTER_AUTH_SECRET;
if (!values.challenge || !values.out || !secret) throw new Error("usage: BETTER_AUTH_SECRET=… bun seed.ts --challenge <dir> --out <dir>");

// ---- the challenge's own generator: deterministic TSVs, byte for byte ----
const tsv = join(out, "tsv");
mkdirSync(out, { recursive: true });
if (!existsSync(join(tsv, "likes.tsv"))) {
  const gen = Bun.spawnSync(["node", join(challenge, "seed/generate.mjs"), tsv], { stdout: "inherit", stderr: "inherit" });
  if (gen.exitCode !== 0) throw new Error("seed generation failed");
}
const tokens: { id: number; username: string }[] = JSON.parse(readFileSync(join(tsv, "tokens.json"), "utf8"));

// ---- ids: users:000…0001 for user 1, and so on, so the same row always gets the same id ----
const hex = (n: number) => n.toString(16).padStart(32, "0");
const userId = (n: number) => `users:${hex(n)}`;
const postId = (n: number) => `posts:${hex(n)}`;
const likeId = (n: number) => `likes:${hex(n)}`;
const ms = (iso: string) => Date.parse(iso);

const dbPath = join(out, "app.db");
for (const suffix of ["", "-wal", "-shm", "-log"]) rmSync(dbPath + suffix, { force: true });
const project = await loadProject(resolve(import.meta.dir, "forge"));
// The engine's own adapter creates the file: Turso refuses databases written by SQLite, and the other way round. Run the engine with the same SQLITE_DRIVER.
const db = await createLocalDb(dbPath, values.driver as "turso" | "bun");
await migrateSystem(db);
// Indexes first: Turso builds an index over a loaded table in memory (over 2.5 GB for the 2.5 million rows here), but maintains one as rows arrive.
await db.migrate(tableSpecs(project.tables));

type Row = [string, number, string];
const ROWS_PER_STATEMENT = 100;
/** One transaction, multi-row inserts. */
const insertRows = (table: string, rows: Row[]) =>
  db.transaction("write", async (tx) => {
    for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
      const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
      await tx.execute(`INSERT INTO "${table}" ("_id", "_creationTime", "doc") VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`, chunk.flat());
    }
  });
const lines = (file: string) => {
  const text = readFileSync(file, "utf8");
  return (function* () {
    for (let at = 0; at < text.length; ) {
      const end = text.indexOf("\n", at);
      yield text.slice(at, end === -1 ? text.length : end);
      if (end === -1) break;
      at = end + 1;
    }
  })();
};
/** Rows in transactions of 50,000: fast, and a crash never leaves half a table. */
async function load(label: string, table: string, rows: Iterable<string>, row: (cols: string[], n: number) => [string, number, object]) {
  const t0 = performance.now();
  let n = 0;
  let pending: Row[] = [];
  for (const line of rows) {
    if (!line) continue;
    const [id, time, doc] = row(line.split("\t"), ++n);
    pending.push([id, time, JSON.stringify(doc)]);
    if (pending.length === 50_000) await insertRows(table, pending), (pending = []);
  }
  if (pending.length) await insertRows(table, pending);
  console.log(`  ${label}: ${n.toLocaleString()} rows in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return n;
}

console.log("loading the challenge's data into archlast-forge tables");
const usersN = await load("users", "users", lines(join(tsv, "users.tsv")), ([id, username, created]) => {
  const t = ms(created!);
  return [userId(+id!), t, { name: username, email: `${username}@bench.local`, emailVerified: true, createdAt: t, updatedAt: t }];
});
const postsN = await load("posts", "posts", lines(join(tsv, "posts.tsv")), ([id, user, body, created]) => [postId(+id!), ms(created!), { authorId: userId(+user!), body }]);
const likesN = await load("likes", "likes", lines(join(tsv, "likes.tsv")), ([user, post, created], n) => [likeId(n), ms(created!), { userId: userId(+user!), postId: postId(+post!) }]);

// ---- sessions: one per token user, with the cookie Better Auth expects (token.HMAC-SHA256(secret, token), base64, URL-encoded) ----
const now = Date.now();
const cookies = tokens.map((t) => {
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return { id: t.id, username: t.username, token, cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}` };
});
await insertRows(
  "sessions",
  cookies.map((c): Row => [`sessions:${hex(c.id)}`, now, JSON.stringify({ userId: userId(c.id), token: c.token, expiresAt: now + 365 * 86400_000, createdAt: now, updatedAt: now })]),
);
console.log(`  sessions: ${cookies.length.toLocaleString()} rows`);

const t0 = performance.now();
await db.execute("ANALYZE"); // the challenge's seed is analyzed too
await db.close();
console.log(`  ANALYZE in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

writeFileSync(join(out, "tokens.json"), JSON.stringify(cookies.map(({ id, username, cookie }) => ({ id, username, cookie }))));
writeFileSync(join(out, "meta.json"), JSON.stringify({ users: usersN, posts: postsN, likes: likesN, sessions: cookies.length }, null, 2));
console.log(`✓ ${dbPath} and tokens.json`);
