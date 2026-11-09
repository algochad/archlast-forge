// The items on Forge's own database (ctx.db, SQLite): one document per item, found by its number through an index. These take the transaction's `db`, and are
// called by routes that read and write it directly: `ctx.read((c) => getItem(c.db, id))` in a minimal route, a DbService's @Read() and @Write() methods in a
// controller. No function of the reactive system is called.
import type { DatabaseReader, DatabaseWriter } from "@archlast/forge-runtime";
import { CAP } from "./store";

type Items = { itemId: number; name: string; quantity: number };
const item = (doc: Items) => ({ id: doc.itemId, name: doc.name, quantity: doc.quantity });
const byId = (db: DatabaseReader, id: number): Promise<(Items & { _id: string }) | null> => (db as any).query("items").withIndex("by_item", (q: any) => q.eq("itemId", id)).first();

export async function getItem(db: DatabaseReader, id: number) {
  const doc = await byId(db, id);
  return doc ? item(doc) : null;
}

export async function listItems(db: DatabaseReader, limit: number) {
  const docs: Items[] = await (db as any).query("items").withIndex("by_item", (q: any) => q.gte("itemId", 1).lte("itemId", limit)).collect();
  return docs.map(item);
}

export async function createItem(db: DatabaseWriter, input: { name: string; quantity: number }) {
  const last: Items | null = await (db as any).query("items").withIndex("by_item").order("desc").first();
  const itemId = Math.max(last?.itemId ?? 0, 1000) + 1;
  await (db as any).insert("items", { itemId, ...input });
  const old = await byId(db, itemId - CAP);
  if (old) await db.delete(old._id as never);
  return { id: itemId, ...input };
}

export async function updateItem(db: DatabaseWriter, id: number, input: { name: string; quantity: number }) {
  const doc = await byId(db, id);
  if (!doc) return null;
  await db.patch(doc._id as never, input as never);
  return { id, ...input };
}

export async function removeItem(db: DatabaseWriter, id: number) {
  const doc = await byId(db, id);
  if (!doc) return false;
  await db.delete(doc._id as never);
  return true;
}

/** Seeds items 1 to 1000 when the table is empty (the harness calls this once after the server starts; it is not part of the measured work). */
export async function seedItems(db: DatabaseWriter) {
  if (await (db as any).query("items").first()) return false;
  await (db as any).insertMany(
    "items",
    Array.from({ length: 1000 }, (_, i) => ({ itemId: i + 1, name: `item-${i + 1}`, quantity: (i + 1) % 100 })),
  );
  return true;
}
