#!/usr/bin/env node
// The challenge's test suite (test/test.sh), translated to the RPC functions. Run it against a server on a FRESH copy of the seed:
// it compares against the challenge's golden files, then writes a post and a few likes.
//
//   node check.mjs --base http://127.0.0.1:3000 --golden <challenge>/test/golden --tokens <seed dir>/tokens.json
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { base: { type: "string" }, golden: { type: "string" }, tokens: { type: "string" } } });
const BASE = values.base ?? "http://127.0.0.1:3000";
const GOLDEN = values.golden;
const tokens = JSON.parse(readFileSync(values.tokens, "utf8"));
const me = tokens[0]; // user 1: golden_ember_1 in the challenge's text, whatever the seed names it
const golden = (f) => JSON.parse(readFileSync(`${GOLDEN}/${f}`, "utf8"));
const hex = (n) => n.toString(16).padStart(32, "0");
const postId = (n) => `posts:${hex(n)}`;

let pass = 0;
let fail = 0;
const ok = (label) => (console.log(`  ok   ${label}`), pass++);
const bad = (label, detail) => (console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`), fail++);
const check = (label, cond, detail) => (cond ? ok(label) : bad(label, detail));

async function call(kind, path, input, cookie) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(kind === "mutation" ? { "Content-Type": "application/json" } : {}) };
  const res =
    kind === "mutation"
      ? await fetch(`${BASE}/rpc/${path}`, { method: "POST", headers, body: typeof input === "string" ? input : JSON.stringify(input) })
      : await fetch(`${BASE}/rpc/${path}${input === undefined ? "" : `?args=${encodeURIComponent(JSON.stringify(input))}`}`, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, ctype: res.headers.get("content-type") ?? "", json, data: json?.result, error: json?.error?.message, text };
}
const query = (path, input, cookie) => call("query", path, input, cookie);
const mutate = (path, input, cookie) => call("mutation", path, input, cookie);
const refuses = (label, r, why) => check(label, r.status >= 400 && r.status < 500 && (r.error ?? "").includes(why), `want 4xx mentioning "${why}", got ${r.status} ${r.text.slice(0, 160)}`);

/** A golden post, in the translated shape. */
const translated = (g) => ({ id: postId(g.id), body: g.body, createdAt: g.created_at, author: g.author, likeCount: g.like_count });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log(`Testing ${BASE}`);

console.log("-- golden reads (fresh database)");
let r = await query("feed:list");
const goldenFeed = golden("feed.json").posts.map(translated);
check("feed.list == golden feed (20 posts, same order, same content)", r.status === 200 && equal(r.data?.posts, goldenFeed), `got ${r.status} ${r.text.slice(0, 200)}`);
check("feed.list content-type is JSON", r.ctype.startsWith("application/json"), r.ctype);
for (const n of [1, 250000, 500000]) {
  r = await query("feed:get", { id: postId(n) });
  check(`feed.get posts ${n} == golden`, r.status === 200 && equal(r.data?.post, translated(golden(`post-${n}.json`).post)), `got ${r.status} ${r.text.slice(0, 200)}`);
}

console.log("-- health, 404s, id validation");
r = await fetch(`${BASE}/ready`);
check("GET /ready -> 200", r.status === 200, String(r.status));
r = await fetch(`${BASE}/health`);
check("GET /health -> 200", r.status === 200, String(r.status));
r = await query("feed:nope");
check("unknown function -> 404", r.status === 404, `${r.status} ${r.text.slice(0, 120)}`);
for (const id of ["0", "-1", "abc", "1.5", "users:00000000000000000000000000000001"]) {
  r = await query("feed:get", { id });
  check(`feed.get id ${JSON.stringify(id)} -> 4xx`, r.status >= 400 && r.status < 500, `${r.status} ${r.text.slice(0, 120)}`);
}
r = await query("feed:get", { id: postId(999999999) });
refuses("feed.get missing post -> post not found", r, "post not found");
r = await query("feed:get", {});
check("feed.get without an id -> 4xx", r.status >= 400 && r.status < 500, String(r.status));

console.log("-- auth");
const [token] = decodeURIComponent(me.cookie.split("=").slice(1).join("=")).split(".");
const cookies = {
  "no cookie": undefined,
  "garbage cookie": "better-auth.session_token=abc",
  "right token, wrong signature": `better-auth.session_token=${encodeURIComponent(`${token}.c2lnbmF0dXJlLWlzLW5vdC12YWxpZC1hdC1hbGw=`)}`,
  "unsigned token": `better-auth.session_token=${token}`,
  "other cookie only": "theme=dark",
};
for (const [label, cookie] of Object.entries(cookies)) {
  refuses(`feed.create, ${label}`, await mutate("feed:create", { body: "x" }, cookie), "session");
  refuses(`feed.like, ${label}`, await mutate("feed:like", { postId: postId(1) }, cookie), "session");
}
refuses("feed.like with a bad id and no session: the session check comes first", await mutate("feed:like", { postId: "abc" }), "session");

console.log("-- create validation");
const A = me.cookie;
const bodyErr = async (label, input, why) => {
  const res = await mutate("feed:create", input, A);
  check(label, res.status >= 400 && res.status < 500 && (res.error ?? res.text).includes(why), `want 4xx "${why}", got ${res.status} ${res.text.slice(0, 160)}`);
};
await bodyErr("empty body", { body: "" }, "body is required");
await bodyErr("whitespace body", { body: "   " }, "body is required");
await bodyErr("numeric body", { body: 123 }, "body");
await bodyErr("missing body", {}, "body");
await bodyErr("malformed JSON", "{bad json", "JSON");
await bodyErr("501-char body", { body: "a".repeat(501) }, "at most 500");

console.log("-- create, like, read back");
r = await mutate("feed:create", { body: '  test: <b>&amp;</b> "quoted" / café ✓  ' }, A);
check("special characters round-trip, trimmed", r.status === 200 && r.data?.post?.body === 'test: <b>&amp;</b> "quoted" / café ✓', `${r.status} ${r.text.slice(0, 200)}`);
const body500 = "b".repeat(500);
r = await mutate("feed:create", { body: `  ${body500} ` }, A);
const created = r.data?.post;
check("create a 500-char post", r.status === 200 && created?.body === body500 && created?.author === me.username && created?.likeCount === 0 && typeof created?.id === "string", `${r.status} ${r.text.slice(0, 200)}`);
check("create response has exactly the post's keys", equal(Object.keys(created ?? {}), ["id", "body", "createdAt", "author", "likeCount"]));
check("createdAt format", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(created?.createdAt ?? ""), created?.createdAt);
const drift = Math.abs(Date.now() - Date.parse(created?.createdAt));
check(`createdAt is now (UTC, ${Math.round(drift / 1000)} s)`, drift < 60_000);

r = await mutate("feed:like", { postId: created.id }, A);
check("like (first): liked, not already liked", r.status === 200 && equal(r.data, { liked: true, alreadyLiked: false, postId: created.id }), `${r.status} ${r.text.slice(0, 160)}`);
r = await mutate("feed:like", { postId: created.id }, A);
check("like (repeat): already liked", r.status === 200 && equal(r.data, { liked: true, alreadyLiked: true, postId: created.id }), `${r.status} ${r.text.slice(0, 160)}`);
refuses("like a missing post", await mutate("feed:like", { postId: postId(999999999) }, A), "post not found");
r = await mutate("feed:like", { postId: "abc" }, A);
check("like with a bad id (with a session) -> 4xx", r.status >= 400 && r.status < 500, `${r.status} ${r.text.slice(0, 120)}`);
r = await query("feed:get", { id: created.id });
check("read back: likeCount 1", equal(r.data?.post, { ...created, likeCount: 1 }), `${r.status} ${r.text.slice(0, 200)}`);

await mutate("feed:like", { postId: postId(1) }, A);
r = await query("feed:get", { id: postId(1) });
const want = golden("post-1.json").post.like_count + 1;
check(`a like on a seeded post is counted at once (${want})`, r.data?.post?.likeCount === want, `got ${r.data?.post?.likeCount}`);

r = await query("feed:list");
check("feed has 20 posts", r.data?.posts?.length === 20, String(r.data?.posts?.length));
const top = r.data?.posts?.[0];
check("the newest post is at the top of the feed", top?.id === created.id, JSON.stringify(top));
check("feed entry matches the post", equal(r.data?.posts?.find((p) => p.id === created.id), { ...created, likeCount: 1 }));

console.log(`passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
