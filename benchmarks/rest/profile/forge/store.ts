// The in-memory store the JavaScript servers (Forge, Express, Bun.serve) share, so they run the same code and differ only in what serves HTTP.
// The other languages implement the same rules (see ../README.md): seeded with ids 1..1000, ids count up from 1001, and at most CAP items are kept
// (creating item `id` removes item `id - CAP`), so a long create run does not fill the memory.
export interface Item {
  id: number;
  name: string;
  quantity: number;
}

export const CAP = 100_000;
const items = new Map<number, Item>();
let nextId = 1001;
for (let id = 1; id <= 1000; id++) items.set(id, { id, name: `item-${id}`, quantity: id % 100 });

export type Input = { name: string; quantity: number };

/** The body as an `Input`, or null when it is not one: a non-empty name of at most 100 characters and a whole quantity of 0 or more. */
export function parse(body: unknown): Input | null {
  if (body === null || typeof body !== "object") return null;
  const { name, quantity } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0 || name.length > 100) return null;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) return null;
  return { name, quantity };
}

export const get = (id: number): Item | undefined => items.get(id);

export function list(limit: number): Item[] {
  const out: Item[] = [];
  for (let id = 1; id <= limit; id++) {
    const item = items.get(id);
    if (item) out.push(item);
  }
  return out;
}

export function create(input: Input): Item {
  const item = { id: nextId++, ...input };
  items.set(item.id, item);
  items.delete(item.id - CAP);
  return item;
}

export function update(id: number, input: Input): Item | undefined {
  if (!items.has(id)) return undefined;
  const item = { id, ...input };
  items.set(id, item);
  return item;
}

export const remove = (id: number): boolean => items.delete(id);

/** `?limit=`: 20 when absent, otherwise a whole number from 1 to 100 (anything else is 20). */
export function limitOf(raw: string | null | undefined): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 20;
}

/** The id in a path, or null when it is not a whole number of 1 or more. */
export function idOf(raw: string | undefined): number | null {
  const n = raw == null || !/^\d{1,15}$/.test(raw) ? NaN : Number(raw);
  return n >= 1 ? n : null;
}
