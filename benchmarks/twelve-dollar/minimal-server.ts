// A yardstick, not part of the BaaS: the same four calls written as a hand-tuned single-file server would be (Bun.serve, bun:sqlite
// prepared statements, nothing else), on the same seeded database. CACHE=1 adds the simplest exact cache: response bodies dropped by the
// writes that change them.  SECRET=<BETTER_AUTH_SECRET> [CACHE=1] bun minimal-server.ts <app.db> [port]
import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
const db = new Database(process.argv[2]!);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
const secret = process.env.SECRET!;
const J = `json_extract("doc", '$.`;
const newest = db.query(`SELECT "_id", "_creationTime", "doc" FROM "posts" ORDER BY "_creationTime" DESC, "_id" DESC LIMIT 20`);
const postById = db.query(`SELECT "_id", "_creationTime", "doc" FROM "posts" WHERE "_id" = ?`);
const userById = db.query(`SELECT "doc" FROM "users" WHERE "_id" = ?`);
const likeCount = db.query(`SELECT COUNT(*) AS n FROM "likes" WHERE ${J}postId') = ?`);
const session = db.query(`SELECT "doc" FROM "sessions" WHERE ${J}token') = ?`);
const liked = db.query(`SELECT 1 FROM "likes" WHERE ${J}userId') = ? AND ${J}postId') = ?`);
const insertLike = db.query(`INSERT INTO "likes" ("_id", "_creationTime", "doc") VALUES (?, ?, ?)`);
const insertPost = db.query(`INSERT INTO "posts" ("_id", "_creationTime", "doc") VALUES (?, ?, ?)`);
const present = (row: any) => {
  const doc = JSON.parse(row.doc);
  const author = userById.get(doc.authorId) as any;
  return { id: row._id, body: doc.body, createdAt: new Date(row._creationTime).toISOString(), author: author ? JSON.parse(author.doc).name : "", likeCount: (likeCount.get(row._id) as any).n };
};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const me = (req: Request) => {
  const c = req.headers.get("cookie") ?? "";
  const m = /better-auth\.session_token=([^;]+)/.exec(c);
  if (!m) return null;
  const v = decodeURIComponent(m[1]!);
  const dot = v.lastIndexOf(".");
  const token = v.slice(0, dot);
  const sig = Buffer.from(v.slice(dot + 1));
  const want = Buffer.from(createHmac("sha256", secret).update(token).digest("base64"));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  const s = session.get(token) as any;
  if (!s) return null;
  const doc = JSON.parse(s.doc);
  const u = userById.get(doc.userId) as any;
  return u ? { id: doc.userId, name: JSON.parse(u.doc).name } : null;
};
const id = () => crypto.randomUUID().replaceAll("-", "");
// The simplest exact cache: response bodies, dropped by exactly the writes that change them.
const CACHE = process.env.CACHE === "1";
let listBody: Uint8Array | undefined;
let listIds = new Set<string>();
const getBodies = new Map<string, Uint8Array>();
const enc = new TextEncoder();
const body = (v: unknown) => enc.encode(JSON.stringify(v));
const ok = (b: Uint8Array) => new Response(b, { headers: { "content-type": "application/json" } });
Bun.serve({
  port: Number(process.argv[3] ?? 3101),
  async fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/rpc/feed:list": {
        if (CACHE && listBody) return ok(listBody);
        const posts = newest.all().map(present);
        const b = body({ result: { posts } });
        if (CACHE) (listBody = b), (listIds = new Set(posts.map((p) => p.id)));
        return ok(b);
      }
      case "/rpc/feed:get": {
        const raw = url.searchParams.get("args") ?? "{}";
        const hit = CACHE && getBodies.get(raw);
        if (hit) return ok(hit);
        const pid = JSON.parse(raw).id;
        const row = postById.get(pid);
        if (!row) return json({ error: { message: "post not found" } }, 400);
        const b = body({ result: { post: present(row) } });
        if (CACHE) getBodies.set(raw, b);
        return ok(b);
      }
      case "/rpc/feed:like": {
        const user = me(req);
        if (!user) return json({ error: { message: "session" } }, 400);
        const { postId } = (await req.json()) as any;
        if (!postById.get(postId)) return json({ error: { message: "post not found" } }, 400);
        const already = Boolean(liked.get(user.id, postId));
        if (!already) {
          insertLike.run(`likes:${id()}`, performance.timeOrigin + performance.now(), JSON.stringify({ userId: user.id, postId }));
          if (CACHE) {
            for (const k of getBodies.keys()) if (k.includes(postId)) getBodies.delete(k);
            if (listIds.has(postId)) listBody = undefined;
          }
        }
        return json({ result: { liked: true, alreadyLiked: already, postId } });
      }
      case "/rpc/feed:create": {
        const user = me(req);
        if (!user) return json({ error: { message: "session" } }, 400);
        const text = String(((await req.json()) as any).body ?? "").trim();
        const pid = `posts:${id()}`;
        const t = performance.timeOrigin + performance.now();
        insertPost.run(pid, t, JSON.stringify({ authorId: user.id, body: text }));
        if (CACHE) listBody = undefined;
        return json({ result: { post: { id: pid, body: text, createdAt: new Date(t).toISOString(), author: user.name, likeCount: 0 } } });
      }
    }
    return json({ error: { message: "not found" } }, 404);
  },
});
console.log("up");
