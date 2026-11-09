// The API's rules that do not depend on where the items are kept (the same as store.ts has): what a valid body is, and how `limit` and an id are read.
export interface Item {
  id: number;
  name: string;
  quantity: number;
}

export const CAP = 100_000;

export type Input = { name: string; quantity: number };

/** The body as an `Input`, or null when it is not one: a non-empty name of at most 100 characters and a whole quantity of 0 or more. */
export function parse(body: unknown): Input | null {
  if (body === null || typeof body !== "object") return null;
  const { name, quantity } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0 || name.length > 100) return null;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) return null;
  return { name, quantity };
}

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
