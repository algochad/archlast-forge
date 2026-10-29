// The landing page (index.html). Docs pages are built from Markdown in build.ts; this one is written by hand.
import { codeBlock } from "./highlight";
import { GITHUB, NPM, escape, icons, mark, page, topbar } from "./layout";

const schema = `import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({
  notes: defineTable({
    ownerId: v.id("users"),
    title: v.string(),
    pinned: v.boolean(),
  }).index("by_owner", ["ownerId"]),
});`;

const functions = `import { ForgeError, mutation, query, v } from "@archlast/forge-runtime";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in to use notes");
    return ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("ownerId", me.userId)).take(100);
  },
});

export const add = mutation({
  args: { title: v.string() },
  handler: async (ctx, { title }) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in to use notes");
    return ctx.db.insert("notes", { ownerId: me.userId, title, pinned: false });
  },
});`;

const component = `import { useMutation, useQuery } from "@archlast/forge-react";
import { api } from "../../forge/_generated/api";

export default function Notes() {
  const notes = useQuery(api.notes.list); // undefined once, then live
  const add = useMutation(api.notes.add);
  return (
    <>
      <button onClick={() => add({ title: "New note" })}>Add</button>
      <ul>{notes?.map((n) => <li key={n._id}>{n.title}</li>)}</ul>
    </>
  );
}`;

const features = [
  ["Live queries", "A query's result updates in every open window when the data it read changes. No polling, no refresh code.", "reactivity.html"],
  ["Typed end to end", "The client's types come from your functions. Arguments and results are validated on the server.", "clients.html"],
  ["Auth built in", "Better Auth with email and password out of the box. Plugins and social sign-in through one file.", "auth.html"],
  ["SQLite or PostgreSQL", "A single file to start, a shared database when you grow. Add Redis to run several servers.", "deployment.html"],
  ["Full-stack React", "File routes, server rendering, loaders and live data in one process, built with Bun.", "framework.html"],
  ["Backend mode", "The engine and its services as a Docker Compose stack, for any frontend or none at all.", "backend.html"],
  ["HTTP endpoints", "Webhooks and public APIs as plain routes, run as actions with the same database and auth.", "http.html"],
  ["Scheduling and crons", "Run a function later or on a schedule. Scheduled mutations run exactly once.", "scheduling.html"],
  ["File storage", "Browser-to-S3 uploads with presigned URLs. File bytes never pass through the engine.", "storage.html"],
] as const;

const promises = [
  ["Transactions", "Every mutation runs in one. It commits whole or not at all."],
  ["Types from your code", "Change a function and the client's types change with it. No codegen step to forget."],
  ["Narrow live queries", "A query wakes only for writes it could have seen, so a busy table doesn't wake everyone."],
  ["Honest retries", "Scheduled mutations run exactly once. Actions run at most once and never retry on their own."],
  ["Your data, your disk", "One deployment per app, on SQLite or PostgreSQL that you run. No control plane."],
] as const;

const steps = [
  ["Describe your data", "A schema with validators gives every document a TypeScript type and rejects bad writes before they reach the database. Indexes make reads narrow, which keeps live queries cheap.", "forge/schema.ts", schema, "schema.html"],
  ["Write functions", "Queries read, mutations write inside a transaction, actions talk to the outside world. Your code runs on your server, next to your data.", "forge/notes.ts", functions, "functions.html"],
  ["Use them, live", "Call a function from React, Vue or Svelte. The component shows the result and updates itself whenever it changes.", "app/routes/notes.tsx", component, "clients.html"],
] as const;

const footer = (cols: [string, [string, string][]][]) => {
  const col = (name: string, links: [string, string][], wide = false) => `<div class="foot-col${wide ? " wide" : ""}"><h4>${escape(name)}</h4><div class="foot-links">${links.map(([t, h]) => `<a href="${h}">${escape(t)}</a>`).join("")}</div></div>`;
  const by = Object.fromEntries(cols);
  return `<footer class="foot"><div class="foot-in">
  <div class="foot-brand"><a class="brand" href="index.html">${mark}<span>archlast-forge</span></a><p>A self-hosted reactive backend for TypeScript apps, with an optional full-stack React framework.</p><a class="btn" href="getting-started.html">Get started ${icons.arrow}</a></div>
  ${col("Start", by.Start!)}
  ${col("Build", by.Build!, true)}
  <div class="foot-col">${col("Run", by.Run!)}${col("Reference", by.Reference!)}</div>
  ${col("Project", [["GitHub", GITHUB], ["Issues", `${GITHUB}/issues`], ["npm", NPM], ["License", `${GITHUB}/blob/master/LICENSE`]])}
</div><div class="foot-bar"><span>MIT licensed. One deployment per app, on your own servers.</span><span>Docs built from <a href="${GITHUB}/tree/master/apps/docs">apps/docs</a></span></div></footer>`;
};

const spec = [
  ["Container", "1", "runs the whole app"],
  ["Databases", "2", "SQLite or PostgreSQL"],
  ["Clients", "3", "React, Vue and Svelte"],
] as const;
const stack = ["Bun", "SQLite", "PostgreSQL", "Redis", "S3 storage", "Better Auth", "React Router", "TanStack Query", "Zod"];
const tag = (t: string) => `<span class="tag">${t}</span>`;

export function landing(cols: [string, [string, string][]][]) {
  const pages = cols.reduce((n, [, links]) => n + links.length, 0);
  const body = `<script>document.documentElement.classList.add("js")</script>${topbar()}
<main id="content" class="land">
  <section class="hero">
    <div class="hero-in">
      <div class="hero-copy">
        ${tag("Open source · MIT")}
        <h1>The reactive backend you <span class="hl">host yourself</span>.</h1>
        <p class="lede">Typed queries and mutations with live results, on SQLite or PostgreSQL. Auth, storage and a full-stack React framework are built in. It runs as one container, on your own servers.</p>
        <div class="cta">
          <a class="btn solid" href="getting-started.html">Get started</a>
          <a class="btn" href="introduction.html">Read the docs</a>
          <a class="btn link" href="${GITHUB}" rel="noopener">GitHub ${icons.arrow}</a>
        </div>
        <div class="install" data-install>
          <div class="install-tabs" role="tablist"><button role="tab" aria-selected="true" data-cmd="bun create archlast-forge my-app">bun create</button><button role="tab" aria-selected="false" data-cmd="bunx create-archlast-forge my-app">bunx</button></div>
          <div class="install-line"><span class="prompt">$</span><code id="install-cmd">bun create archlast-forge my-app</code><button type="button" class="copy" data-copy-from="install-cmd" aria-label="Copy command">Copy</button></div>
        </div>
      </div>
      <div class="hero-code">
        ${codeBlock("ts", `// forge/notes.ts: a query. It runs on the server.\nexport const list = query({\n  args: {},\n  handler: async (ctx) => {\n    const me = await ctx.auth.getUserIdentity();\n    if (!me) throw new ForgeError("Sign in to use notes");\n    return ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("ownerId", me.userId)).take(100);\n  },\n});`)}
        <div class="demo" data-demo aria-label="Two browser windows showing the same list updating together">
          <div class="win"><div class="win-bar"><span>Window A</span></div><div class="win-body"><button type="button" class="mini-btn" data-add tabindex="-1">Add note</button><ul data-list></ul></div></div>
          <div class="win"><div class="win-bar"><span>Window B</span><em class="live-tag">Live</em></div><div class="win-body"><div class="mini-label">Updates by itself</div><ul data-list></ul></div></div>
        </div>
      </div>
    </div>
    <div class="spec">
      ${[...spec, ["Docs", String(pages), "pages, with a tutorial"]].map(([k, v, d]) => `<div class="spec-cell"><span class="label">${k}</span><b>${v}</b><span>${d}</span></div>`).join("")}
    </div>
  </section>

  <section class="builton" aria-label="Built on"><span class="label">Built on</span><p>${stack.join('<i>/</i>')}</p></section>

  <section class="sec">
    <div class="wrap">
      <div class="sec-head">${tag("What is inside")}<h2>Everything a backend needs, in one deploy</h2><p>The model will be familiar if you have used Convex. The difference is that you run it.</p></div>
      <div class="cells">${features.map(([title, text, href], i) => `<a class="cell" href="${href}"><span class="label">${String(i + 1).padStart(2, "0")}</span><h3>${title}</h3><p>${text}</p><span class="cell-arrow">${icons.arrow}</span></a>`).join("")}</div>
    </div>
  </section>

  <section class="sec tight">
    <div class="wrap two">
      <div class="sec-head">${tag("What you can rely on")}<h2>Boring where it matters</h2><p>The guarantees are written down in the docs, with the places the engine does not promise anything.</p><a class="btn link" href="limits.html">Limits and security ${icons.arrow}</a></div>
      <ul class="checks">${promises.map(([t, d]) => `<li><span class="box" aria-hidden="true"></span><p><b>${t}.</b> ${d}</p></li>`).join("")}</ul>
    </div>
  </section>

  <section class="sec">
    <div class="wrap">
      <div class="sec-head">${tag("How it works")}<h2>From an empty folder to live data</h2><p>Three files. The tutorial builds this out into a notes app with search, sign-in and tests.</p></div>
      <div class="steps">${steps
        .map(([title, text, file, code, href], i) => `<div class="step"><div class="step-text"><span class="label step-n">${String(i + 1).padStart(2, "0")}</span><h3>${title}</h3><p>${text}</p><a class="btn link" href="${href}">Read more ${icons.arrow}</a></div><div class="step-code">${codeBlock("ts", code, file)}</div></div>`)
        .join("")}</div>
    </div>
  </section>

  <section class="band">
    <div class="wrap">
      <div class="sec-head">${tag("Two ways to run it")}<h2>Pick one when you create the project</h2><p>Both use the same engine, and you can switch later.</p></div>
      <div class="modes">
        <a class="mode" href="framework.html"><h3>Full-stack app</h3><p>React pages rendered on the server, file routes and your backend in one container. A SQLite file is all it needs to start.</p><ul><li>Loaders with data already in the first HTML</li><li>One process in development, with live reload</li><li>Deploy with <code>bun run up</code></li></ul><span class="more">Full-stack apps ${icons.arrow}</span></a>
        <a class="mode" href="backend.html"><h3>Backend only</h3><p>The engine and its services as a Compose stack, for a mobile app, a separate frontend, or no frontend.</p><ul><li>PostgreSQL, Redis and S3 storage included</li><li>Optional Caddy for HTTPS</li><li>Same client libraries for React, Vue and Svelte</li></ul><span class="more">Backends ${icons.arrow}</span></a>
      </div>
    </div>
  </section>

  <section class="closing">
    <div class="wrap">
      <h2>Build something that updates itself.</h2>
      <div class="install"><div class="install-line"><span class="prompt">$</span><code id="close-cmd">bun create archlast-forge my-app</code><button type="button" class="copy" data-copy-from="close-cmd" aria-label="Copy command">Copy</button></div></div>
      <div class="cta"><a class="btn ink" href="getting-started.html">Get started</a><a class="btn ink-outline" href="tutorial.html">Follow the tutorial</a></div>
    </div>
  </section>
</main>
${footer(cols)}`;
  return page({
    title: "archlast-forge: the reactive backend you host yourself",
    description: "A self-hosted reactive backend for TypeScript apps with live queries, auth, storage and an optional full-stack React framework.",
    body,
    bodyClass: "landing",
    css: ["landing.css"],
    js: ["landing.js"],
  });
}
