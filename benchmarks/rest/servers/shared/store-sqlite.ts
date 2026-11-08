
// The store in SQLite (a file on tmpfs, WAL), with the same API as store.ts. Seeded with ids 1..1000; ids count up from 1001 (AUTOINCREMENT); a trigger
// keeps at most CAP items (inserting item `id` deletes item `id - CAP`), so one INSERT is a create. One connection: the JavaScript servers run one thread.
const db = open(process.env.DB_PATH ?? "/data/bench.db");
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
db.exec(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, quantity INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS items_cap AFTER INSERT ON items BEGIN DELETE FROM items WHERE id = NEW.id - ${CAP}; END`);
if (!db.prepare("SELECT 1 AS present FROM items LIMIT 1").get()) {
  const seed = db.prepare("INSERT INTO items (id, name, quantity) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (let id = 1; id <= 1000; id++) seed.run(id, `item-${id}`, id % 100);
  db.exec("COMMIT");
}

const selectOne = db.prepare("SELECT id, name, quantity FROM items WHERE id = ?");
const selectMany = db.prepare("SELECT id, name, quantity FROM items WHERE id BETWEEN 1 AND ? ORDER BY id");
const insert = db.prepare("INSERT INTO items (name, quantity) VALUES (?, ?)");
const replace = db.prepare("UPDATE items SET name = ?, quantity = ? WHERE id = ?");
const erase = db.prepare("DELETE FROM items WHERE id = ?");

export const get = (id: number): Item | undefined => (selectOne.get(id) as Item | null | undefined) ?? undefined;

export const list = (limit: number): Item[] => selectMany.all(limit) as Item[];

export function create(input: Input): Item {
  const { lastInsertRowid } = insert.run(input.name, input.quantity);
  return { id: Number(lastInsertRowid), ...input };
}

export function update(id: number, input: Input): Item | undefined {
  return Number(replace.run(input.name, input.quantity, id).changes) > 0 ? { id, ...input } : undefined;
}

export const remove = (id: number): boolean => Number(erase.run(id).changes) > 0;
