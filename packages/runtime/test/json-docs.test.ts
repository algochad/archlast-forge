import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeDb } from "../src/server/db/native";
import { createSqliteDb } from "../src/server/db/sqlite";
import { createNativeSqliteDb } from "../src/server/db/sqlite-native";
import type { Db } from "../src/server/db/types";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs } from "../src/server/project";
import { ReadCache } from "../src/server/read-cache";

const engines: ("bun" | "native")[] = nativeDb() ? ["bun", "native"] : ["bun"];
const dbs: Db[] = [];
afterAll(() => Promise.all(dbs.map((d) => d.close())));

describe.each(engines)("documents as JSON text (%s)", (engine) => {
  const make = async () => {
    const project = await loadProject(join(import.meta.dir, "fixture"));
    const path = join(mkdtempSync(join(tmpdir(), "afx-json-")), "app.db");
    const db = engine === "native" ? createNativeSqliteDb(path, nativeDb()!, 2, undefined, "NORMAL") : createSqliteDb(path, 2, undefined, "NORMAL");
    dbs.push(db);
    await db.migrate(tableSpecs(project.tables));
    const exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: () => {}, log: () => {}, readCache: new ReadCache() });
    const bodies = ["plain", 'quote " and \\ backslash', "line\nbreak\ttab", "unicode é 漢字 😀", "control \u0001 char", ""];
    const ids: string[] = [];
    for (const [i, body] of bodies.entries()) ids.push(await exec.mutate((s) => s.writer().insert("notes", { body, tag: i % 2 ? "odd" : "even", n: i })));
    return { exec, ids, bodies };
  };
  const read = <T>(exec: Executor, fn: (db: any) => Promise<T>) => exec.read((s) => fn(s.reader())).then((r) => r.value);

  test("getJson, and the terminals' JSON, parse to what the objects are", async () => {
    const { exec, ids } = await make();
    for (const id of ids) {
      const [obj, text] = await read(exec, async (db) => [await db.get(id), await db.getJson(id)] as const);
      expect(JSON.parse(text)).toEqual(obj);
    }
    const q = (db: any) => db.query("notes").withIndex("by_tag_n", (x: any) => x.eq("tag", "odd"));
    const [all, allText] = await read(exec, async (db) => [await q(db).collect(), await q(db).collectJson()] as const);
    expect(all.length).toBe(3);
    expect(JSON.parse(allText)).toEqual(all);
    const [two, twoText] = await read(exec, async (db) => [await q(db).take(2), await q(db).takeJson(2)] as const);
    expect(JSON.parse(twoText)).toEqual(two);
    const [first, firstText] = await read(exec, async (db) => [await q(db).first(), await q(db).firstJson()] as const);
    expect(JSON.parse(firstText)).toEqual(first);
    const [desc, descText] = await read(exec, async (db) => [await q(db).order("desc").collect(), await q(db).order("desc").collectJson()] as const);
    expect(JSON.parse(descText)).toEqual(desc);
  });

  test("nothing there is null, or []", async () => {
    const { exec } = await make();
    expect(await read(exec, (db) => db.getJson("notes:nothing"))).toBe("null");
    const none = (db: any) => db.query("notes").withIndex("by_tag_n", (x: any) => x.eq("tag", "none"));
    expect(await read(exec, (db) => none(db).firstJson())).toBe("null");
    expect(await read(exec, (db) => none(db).collectJson())).toBe("[]");
    expect(await read(exec, (db) => none(db).takeJson(0))).toBe("[]");
  });

  test("filter(), select() and include() need the objects, and the JSON is theirs", async () => {
    const { exec } = await make();
    const base = (db: any) => db.query("notes").withIndex("by_tag_n", (x: any) => x.eq("tag", "odd"));
    const filtered = await read(exec, async (db) => [await base(db).filter((d: any) => d.body.length > 5).collect(), await base(db).filter((d: any) => d.body.length > 5).collectJson()] as const);
    expect(JSON.parse(filtered[1])).toEqual(filtered[0]);
    const picked = await read(exec, async (db) => [await base(db).select(["body"]).collect(), await base(db).select(["body"]).collectJson()] as const);
    expect(JSON.parse(picked[1])).toEqual(picked[0]);
    expect(Object.keys(JSON.parse(picked[1])[0]).sort()).toEqual(["_creationTime", "_id", "body"]);
  });

  test("a read after a write sees it, and the text it gets again is not stale", async () => {
    const { exec, ids } = await make();
    expect(JSON.parse(await read(exec, (db) => db.getJson(ids[0]!))).body).toBe("plain");
    await exec.mutate((s) => s.writer().patch(ids[0]!, { body: "changed" }));
    expect(JSON.parse(await read(exec, (db) => db.getJson(ids[0]!))).body).toBe("changed");
    await exec.mutate((s) => s.writer().delete(ids[0]!));
    expect(await read(exec, (db) => db.getJson(ids[0]!))).toBe("null");
  });

  test("the objects of a read are new each time, whatever the text was kept", async () => {
    const { exec, ids } = await make();
    const a = (await read(exec, (db) => db.get(ids[1]!)))! as { body: string };
    a.body = "mutated by the caller";
    const b = (await read(exec, (db) => db.get(ids[1]!)))! as { body: string };
    expect(b.body).not.toBe("mutated by the caller");
  });
});
