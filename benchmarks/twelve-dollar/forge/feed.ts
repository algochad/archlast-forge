// The challenge's five endpoints as functions. Reads are public; writes need a signed-in user (a Better Auth session).
//   GET /feed             -> feed.list
//   GET /posts/:id        -> feed.get
//   POST /posts           -> feed.create
//   POST /posts/:id/like  -> feed.like
// There is no response or query caching in here: every call reads SQLite while it runs.
import { ForgeError, mutation, query, v, type Doc } from "@archlast-forge/runtime";

type Joined = Doc<"posts"> & { author: Doc<"users"> | null; likeCount: number };

const present = (p: Joined) => ({
  id: p._id,
  body: p.body,
  createdAt: new Date(p._creationTime).toISOString(),
  author: p.author?.name ?? "",
  likeCount: p.likeCount,
});

/** The author and the number of likes, as of this call. */
const withDetails = { author: "authorId", likeCount: { table: "likes", index: "by_post", count: true } } as const;

export const list = query({
  handler: async (ctx) => ({ posts: (await ctx.db.query("posts").order("desc").include(withDetails).take(20)).map(present) }),
});

export const get = query({
  args: { id: v.id("posts") },
  handler: async (ctx, { id }) => {
    const post = await ctx.db.get(id);
    if (!post) throw new ForgeError("post not found");
    return { post: present(await ctx.db.include("posts", post, withDetails)) };
  },
});

export const create = mutation({
  args: { body: v.string() },
  handler: async (ctx, args) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("missing or invalid session");
    const body = args.body.trim();
    if (!body) throw new ForgeError("body is required");
    if (body.length > 500) throw new ForgeError("body must be at most 500 characters");
    const id = await ctx.db.insert("posts", { authorId: me.userId, body });
    const post = (await ctx.db.get(id))!;
    return { post: { id, body, createdAt: new Date(post._creationTime).toISOString(), author: me.name, likeCount: 0 } };
  },
});

export const like = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("missing or invalid session");
    if (!(await ctx.db.get(postId))) throw new ForgeError("post not found");
    const existing = await ctx.db.query("likes").withIndex("by_user_post", (q) => q.eq("userId", me.userId).eq("postId", postId)).first();
    if (!existing) await ctx.db.insert("likes", { userId: me.userId, postId });
    return { liked: true, alreadyLiked: Boolean(existing), postId };
  },
});
