import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Db } from "../src/server/db/types";
import { adminOp } from "../src/server/admin-ops";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs, type Project } from "../src/server/project";
import { dbAdapters } from "./helpers";

const fixture = join(import.meta.dir, "fixture");

for (const [label, makeDb] of dbAdapters.filter(([l]) => l === "sqlite (:memory:)" || l === "postgres")) {
  describe(`joins, filters and aggregates: ${label}`, () => {
    let project: Project;
    let db: Db;
    let exec: Executor;

    beforeEach(async () => {
      project ??= await loadProject(fixture);
      db = await makeDb();
      await db.migrate(tableSpecs(project.tables));
      exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: () => {}, log: () => {} });
    });
    afterEach(() => db.close());

    const read = async <T>(fn: (db: any) => Promise<T>) => (await exec.read((s) => fn(s.reader()))).value as T;
    const write = <T>(fn: (db: any) => Promise<T>) => exec.mutate((s) => fn(s.writer())) as Promise<T>;

    /** Two lists; "build" has three todos (a depends on b and a deleted one), "home" has one; comments on a. */
    async function seed() {
      return write(async (db) => {
        const user = await db.insert("users", { name: "Ada", email: "ada@x.dev", emailVerified: true, createdAt: 1, updatedAt: 1 });
        const build = await db.insert("lists", { name: "build" });
        const home = await db.insert("lists", { name: "home" });
        const b = await db.insert("todos", { listId: build, title: "b", done: true });
        const ghost = await db.insert("todos", { listId: home, title: "ghost", done: false });
        const a = await db.insert("todos", { listId: build, title: "a", done: false, assigneeId: user, blockedBy: [b, ghost] });
        const c = await db.insert("todos", { listId: build, title: "c", done: false });
        const h = await db.insert("todos", { listId: home, title: "h", done: true });
        await db.delete(ghost); // a still points at it
        for (const [body, score] of [
          ["one", 3],
          ["two", 5],
          ["three", 4],
        ] as const)
          await db.insert("comments", { todoId: a, body, score });
        await db.insert("comments", { todoId: h, body: "elsewhere" });
        return { user, build, home, a, b, c, h, ghost };
      });
    }

    test("a forward include follows an id field, giving null when it's missing or dangling", async () => {
      const ids = await seed();
      const todos = await read<any[]>((db) =>
        db
          .query("todos")
          .withIndex("by_list", (q: any) => q.eq("listId", ids.build))
          .include({ list: "listId", assignee: "assigneeId" })
          .collect(),
      );
      const a = todos.find((t) => t.title === "a");
      expect(a.list).toMatchObject({ _id: ids.build, name: "build" });
      expect(a.assignee).toMatchObject({ name: "Ada" });
      expect(todos.find((t) => t.title === "b").assignee).toBeNull();
    });

    test("an array of ids follows to the documents that still exist", async () => {
      const ids = await seed();
      const a = await read<any>((db) =>
        db
          .query("todos")
          .withIndex("by_list", (q: any) => q.eq("listId", ids.build))
          .include({ blockers: "blockedBy" })
          .first(),
      );
      const [full] = await read<any[]>((db) =>
        db
          .query("todos")
          .filter((t: any) => t.title === "a")
          .include({ blockers: "blockedBy" })
          .collect(),
      );
      expect(a).toBeTruthy();
      expect(full.blockers.map((t: any) => t.title)).toEqual(["b"]); // the deleted one is dropped, not null
    });

    test("a reverse include finds what points back, ordered, and nests", async () => {
      const ids = await seed();
      const lists = await read<any[]>((db) =>
        db
          .query("lists")
          .include({ todos: { table: "todos", index: "by_list", include: { comments: { table: "comments", index: "by_todo" }, list: "listId" } } })
          .collect(),
      );
      const build = lists.find((l) => l.name === "build");
      expect(build.todos.map((t: any) => t.title)).toEqual(["b", "a", "c"]); // insertion order
      expect(build.todos.find((t: any) => t.title === "a").comments.map((c: any) => c.body)).toEqual(["one", "two", "three"]);
      expect(build.todos[0].list._id).toBe(ids.build);
      expect(lists.find((l) => l.name === "home").todos.map((t: any) => t.title)).toEqual(["h"]);
    });

    test("a reverse include can reverse the order, limit per parent, or just count", async () => {
      await seed();
      const [build] = await read<any[]>((db) =>
        db
          .query("lists")
          .filter((l: any) => l.name === "build")
          .include({
            newest: { table: "todos", index: "by_list", order: "desc", take: 2 },
            all: { table: "todos", index: "by_list", order: "desc" },
            total: { table: "todos", index: "by_list", count: true },
          })
          .collect(),
      );
      expect(build.newest.map((t: any) => t.title)).toEqual(["c", "a"]);
      expect(build.all.map((t: any) => t.title)).toEqual(["c", "a", "b"]);
      expect(build.total).toBe(3);
    });

    test("an index's later fields order the children", async () => {
      const ids = await seed();
      const a = await read<any>((db) =>
        db
          .query("todos")
          .filter((t: any) => t._id === ids.a)
          .include({ byScore: { table: "comments", index: "by_todo_score" } })
          .first(),
      );
      expect(a.byScore.map((c: any) => c.score)).toEqual([3, 4, 5]);
    });

    test("many parents at once give each its own children", async () => {
      await write(async (db) => {
        const lists = [];
        for (let i = 0; i < 250; i++) lists.push(await db.insert("lists", { name: `l${i}` })); // more than one batch of parents
        for (let i = 0; i < 250; i += 5) await db.insert("todos", { listId: lists[i], title: `t${i}`, done: false });
      });
      const lists = await read<any[]>((db) =>
        db
          .query("lists")
          .include({ todos: { table: "todos", index: "by_list" } })
          .collect(),
      );
      expect(lists).toHaveLength(250);
      expect(lists.filter((l) => l.todos.length).length).toBe(50);
      for (const l of lists) for (const t of l.todos) expect(t.listId).toBe(l._id);
    });

    test("counting for many parents at once gives each its own count, zero for those with none", async () => {
      const ids: string[] = [];
      await write(async (db) => {
        for (let i = 0; i < 230; i++) ids.push(await db.insert("lists", { name: `c${i}` })); // more than one batch of parents
        for (let i = 0; i < 230; i++) for (let k = 0; k < i % 4; k++) await db.insert("todos", { listId: ids[i], title: `t${i}.${k}`, done: false });
      });
      const counted = () => read<any[]>((db) => db.query("lists").include({ total: { table: "todos", index: "by_list", count: true } }).collect());
      let lists = await counted();
      expect(lists).toHaveLength(230);
      lists.forEach((l) => expect(l.total).toBe(ids.indexOf(l._id) % 4));
      // A count is read live: one more child changes only its parent's count.
      await write((db) => db.insert("todos", { listId: ids[0], title: "extra", done: false }));
      lists = await counted();
      expect(lists.find((l) => l._id === ids[0])!.total).toBe(1);
      expect(lists.find((l) => l._id === ids[1])!.total).toBe(1);
    });

    test("include works on pages, search results and ids you already have", async () => {
      const ids = await seed();
      const page = await read<any>((db) =>
        db
          .query("todos")
          .withIndex("by_list", (q: any) => q.eq("listId", ids.build))
          .include({ list: "listId" })
          .paginate({ numItems: 2, cursor: null }),
      );
      expect(page.page).toHaveLength(2);
      expect(page.page.every((t: any) => t.list.name === "build")).toBe(true);
      const next = await read<any>((db) =>
        db
          .query("todos")
          .withIndex("by_list", (q: any) => q.eq("listId", ids.build))
          .include({ list: "listId" })
          .paginate({ numItems: 2, cursor: page.continueCursor }),
      );
      expect(next.page.map((t: any) => t.title)).toEqual(["c"]);
      expect(next.isDone).toBe(true);

      const doc = await read<any>(async (db) => db.include("todos", await db.get(ids.a), { list: "listId", comments: { table: "comments", index: "by_todo", count: true } }));
      expect(doc).toMatchObject({ title: "a", list: { name: "build" }, comments: 3 });
      expect(await read((db) => db.include("todos", null, { list: "listId" }))).toBeNull();
      const many = await read<any[]>(async (db) => db.include("todos", await db.query("todos").collect(), { list: "listId" }));
      expect(many).toHaveLength(4);
    });

    test("getMany keeps the order, repeats, mixes tables and reports what's missing", async () => {
      const ids = await seed();
      const got = await read<any[]>((db) => db.getMany([ids.c, ids.ghost, ids.build, ids.c, ids.a]));
      expect(got.map((d) => d && (d.title ?? d.name))).toEqual(["c", null, "build", "c", "a"]);
      expect(await read((db) => db.getMany([]))).toEqual([]);
      const lots = await read<any[]>((db) => db.getMany(Array.from({ length: 1200 }, () => ids.a))); // more than one IN chunk
      expect(lots.every((d) => d?.title === "a")).toBe(true);
    });

    test("bad includes are refused with a reason", async () => {
      await seed();
      const bad = (spec: object) => read((db) => db.query("todos").include(spec).collect());
      await expect(bad({ x: "title" })).rejects.toThrow(`"todos.title" isn't a reference`);
      await expect(bad({ x: "nope" })).rejects.toThrow("isn't a reference");
      await expect(bad({ title: "listId" })).rejects.toThrow(`"title" is already a field`);
      await expect(bad({ x: { table: "comments", index: "nope" } })).rejects.toThrow("unknown index");
      await expect(bad({ x: { table: "comments", index: "by_todo" } })).resolves.toBeDefined(); // todos <- comments is fine
      await expect(
        read((db) =>
          db
            .query("lists")
            .include({ x: { table: "comments", index: "by_todo" } })
            .collect(),
        ),
      ).rejects.toThrow(`must start with a v.id("lists") field`);
      await expect(
        read((db) =>
          db
            .query("lists")
            .include({ x: { table: "todos", index: "by_creation_time" } })
            .collect(),
        ),
      ).rejects.toThrow("unknown index");
      await expect(
        read((db) =>
          db
            .query("lists")
            .include({ x: { table: "todos", index: "by_list", take: -1 } })
            .collect(),
        ),
      ).rejects.toThrow("take must be");
    });

    test("filter keeps matching documents, looking past what it skips", async () => {
      await write(async (db) => {
        const list = await db.insert("lists", { name: "many" });
        for (let i = 0; i < 700; i++) await db.insert("todos", { listId: list, title: `t${i}`, done: i % 7 === 0 });
      });
      const firstFive = await read<any[]>((db) =>
        db
          .query("todos")
          .filter((t: any) => t.done)
          .take(5),
      );
      expect(firstFive.map((t) => t.title)).toEqual(["t0", "t7", "t14", "t21", "t28"]);
      expect(
        await read((db) =>
          db
            .query("todos")
            .filter((t: any) => t.done)
            .count(),
        ),
      ).toBe(100);
      expect(await read((db) => db.query("todos").count())).toBe(700);
      expect(
        await read<any>((db) =>
          db
            .query("todos")
            .filter((t: any) => t.title === "t699")
            .first(),
        ),
      ).toMatchObject({ title: "t699" });
      // several filters all apply, and ordering still works
      const both = await read<any[]>((db) =>
        db
          .query("todos")
          .order("desc")
          .filter((t: any) => t.done)
          .filter((t: any) => Number(t.title.slice(1)) > 600)
          .collect(),
      );
      expect(both.map((t) => t.title)).toEqual(["t693", "t686", "t679", "t672", "t665", "t658", "t651", "t644", "t637", "t630", "t623", "t616", "t609", "t602"]);
    });

    test("pagination with a filter pages through every match exactly once", async () => {
      await write(async (db) => {
        const list = await db.insert("lists", { name: "p" });
        for (let i = 0; i < 640; i++) await db.insert("todos", { listId: list, title: `t${i}`, done: i % 5 === 0 });
      });
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; ; pages++) {
        const page: any = await read((db) =>
          db
            .query("todos")
            .filter((t: any) => t.done)
            .paginate({ numItems: 30, cursor }),
        );
        seen.push(...page.page.map((t: any) => t.title));
        if (page.isDone) break;
        expect(page.page).toHaveLength(30);
        cursor = page.continueCursor;
        expect(pages).toBeLessThan(10);
      }
      expect(seen).toHaveLength(128);
      expect(new Set(seen).size).toBe(128);
      expect(seen[0]).toBe("t0");
      expect(seen.at(-1)).toBe("t635");
    });

    test("a filter sees what was included before it, and includes after it only run on what's left", async () => {
      await seed();
      const inBuild = await read<any[]>((db) =>
        db
          .query("todos")
          .include({ list: "listId" })
          .filter((t: any) => t.list?.name === "build")
          .collect(),
      );
      expect(inBuild.map((t) => t.title).sort()).toEqual(["a", "b", "c"]);
      const none = await read<any[]>((db) =>
        db
          .query("todos")
          .filter((t: any) => t.list === undefined)
          .include({ list: "listId" })
          .collect(),
      );
      expect(none).toHaveLength(4); // before the include there is no `list`, so all pass
      expect(none.every((t) => t.list)).toBe(true);
    });

    test("unique, first and count", async () => {
      await seed();
      expect(
        await read<any>((db) =>
          db
            .query("lists")
            .filter((l: any) => l.name === "home")
            .unique(),
        ),
      ).toMatchObject({ name: "home" });
      expect(
        await read((db) =>
          db
            .query("lists")
            .filter((l: any) => l.name === "none")
            .unique(),
        ),
      ).toBeNull();
      await expect(read((db) => db.query("lists").unique())).rejects.toThrow("unique() found more than one");
      expect(await read((db) => db.query("lists").count())).toBe(2);
      expect(
        await read((db) =>
          db
            .query("todos")
            .withIndex("by_list_done", (q: any) => q.eq("listId", "lists:none"))
            .count(),
        ),
      ).toBe(0);
    });

    test("aggregates over a number field", async () => {
      const ids = await seed();
      const agg = (name: string, field = "score") =>
        read<any>((db) =>
          db
            .query("comments")
            .withIndex("by_todo", (q: any) => q.eq("todoId", ids.a))
            [name](field),
        );
      expect(await agg("sum")).toBe(12);
      expect(await agg("avg")).toBe(4);
      expect(await agg("min")).toBe(3);
      expect(await agg("max")).toBe(5);
      // documents without the field are skipped; nothing matched means null (0 for a sum)
      expect(
        await read((db) =>
          db
            .query("comments")
            .withIndex("by_todo", (q: any) => q.eq("todoId", ids.h))
            .sum("score"),
        ),
      ).toBe(0);
      expect(
        await read((db) =>
          db
            .query("comments")
            .withIndex("by_todo", (q: any) => q.eq("todoId", ids.h))
            .avg("score"),
        ),
      ).toBeNull();
      expect(
        await read((db) =>
          db
            .query("comments")
            .filter((c: any) => c.body !== "one")
            .max("score"),
        ),
      ).toBe(5);
      await expect(agg("sum", "body")).rejects.toThrow("needs a number field");
      expect(await read((db) => db.query("lists").max("_creationTime"))).toBeGreaterThan(0);
    });

    const admin = (op: string, args: object) => adminOp({ db, exec, functions: project.functions, tables: project.tables, crons: [], serverId: "test" }, op, args, "test") as Promise<any>;

    test("the dashboard can resolve many ids at once, and learn what points at a document", async () => {
      const ids = await seed();
      const docs = await admin("docsByIds", { ids: [ids.build, ids.ghost, "nonsense", "nothing:x", ids.build, ids.a, 7] });
      expect(Object.keys(docs).sort()).toEqual([ids.build, ids.ghost, "nonsense", "nothing:x", ids.a].sort());
      expect(docs[ids.build]).toMatchObject({ name: "build" });
      expect(docs[ids.ghost]).toBeNull();
      expect(docs.nonsense).toBeNull();
      expect(docs[ids.a]).toMatchObject({ title: "a" });

      const refs = await admin("references", { id: ids.build });
      expect(refs).toEqual([{ table: "todos", field: "listId", many: false, index: "by_list", count: 3 }]);
      const todo = await admin("references", { id: ids.a });
      expect(todo).toContainEqual({ table: "comments", field: "todoId", many: false, index: "by_todo", count: 3 });
      expect(todo).toContainEqual({ table: "todos", field: "blockedBy", many: true, index: null, count: 0 });
      const blocker = await admin("references", { id: ids.b });
      expect(blocker).toContainEqual({ table: "todos", field: "blockedBy", many: true, index: null, count: 1 });
      const user = await admin("references", { id: ids.user });
      expect(user).toContainEqual({ table: "todos", field: "assigneeId", many: false, index: null, count: 1 }); // no index: counted by scanning
      expect(user.find((r: any) => r.table === "sessions")).toMatchObject({ field: "userId", index: "by_userId", count: 0 });
      await expect(admin("references", { id: "nothing:x" })).rejects.toThrow("Invalid id");
    });

    test("a join reads what it needs: the targets' ids, and each parent's index range", async () => {
      const ids = await seed();
      const { reads } = await exec.read((s) =>
        s
          .reader()
          .query("todos")
          .withIndex("by_list", (q: any) => q.eq("listId", ids.build))
          .include({ list: "listId", comments: { table: "comments", index: "by_todo" } })
          .collect(),
      );
      expect(reads.has(`lists:by_id:["${ids.build}"]`)).toBe(true);
      expect(reads.has(`comments:by_todo:["${ids.a}"]`)).toBe(true);
      expect(reads.has(`comments:by_todo:["${ids.b}"]`)).toBe(true);
      expect(reads.has(`todos:by_list:["${ids.build}"]`)).toBe(true);
    });

    test("changing joined data re-runs the query that joined it", async () => {
      const published: string[][] = [];
      exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: (t) => published.push(t), log: () => {} });
      const ids = await seed();
      const { reads } = await exec.read((s) => s.reader().query("todos").include({ list: "listId" }).collect());
      published.length = 0;
      await write((db) => db.patch(ids.build, { name: "renamed" }));
      expect(published.flat().some((t) => reads.has(t))).toBe(true);
      published.length = 0;
      await write((db) => db.insert("comments", { todoId: ids.a, body: "late" }));
      const joined = await exec.read((s) =>
        s
          .reader()
          .query("todos")
          .include({ c: { table: "comments", index: "by_todo" } })
          .collect(),
      );
      expect(published.flat().some((t) => joined.reads.has(t))).toBe(true);
    });
  });
}
