import type { Doc, Manifest, TableInfo, Validator } from "./api";

/** A field that refers to another table: `v.id("lists")`, optionally wrapped in `v.optional`, or an array of them. */
export type Ref = { field: string; target: string; many: boolean; optional: boolean };
/** The other direction: a field in `table` that refers to the table being looked at. */
export type Incoming = Ref & { table: string; index: string | null };

export const referenceOf = (v: Validator): { target: string; many: boolean } | undefined =>
  v.kind === "id" && v.table ? { target: v.table, many: false } : v.kind === "array" && v.element?.kind === "id" && v.element.table ? { target: v.element.table, many: true } : undefined;

export const refsOf = (info: TableInfo): Ref[] =>
  Object.entries(info.fields).flatMap(([field, v]) => {
    const ref = referenceOf(v);
    return ref ? [{ field, optional: v.optional, ...ref }] : [];
  });

/** An index that starts with the field, so documents can be found by it. Arrays can't be looked up that way. */
export const indexFor = (info: TableInfo, field: string): string | null =>
  info.fields[field]?.kind === "array" ? null : (Object.entries(info.indexes).find(([, fields]) => fields[0] === field)?.[0] ?? null);

/** Everything in the schema that points at `table`. */
export const incomingOf = (manifest: Manifest, table: string): Incoming[] =>
  Object.entries(manifest.tables).flatMap(([name, info]) =>
    refsOf(info)
      .filter((r) => r.target === table)
      .map((r) => ({ ...r, table: name, index: indexFor(info, r.field) })),
  );

/** The ids in a reference field's value (one id, an array of them, or nothing). */
export const idsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : typeof value === "string" ? [value] : []);

const NAMEY = ["name", "title", "label", "email", "slug", "subject", "key", "identifier", "body"];
const ID = /^[a-zA-Z_][\w]*:[0-9a-f]{32}$/;
const clip = (s: string, n = 36) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What to call a document in a link: its name or title if it has one, else the first readable text, else a short id. */
export function labelOf(doc: Doc | null | undefined, id: string): string {
  if (doc) {
    for (const key of NAMEY) if (typeof doc[key] === "string" && doc[key]) return clip(doc[key] as string);
    for (const [key, value] of Object.entries(doc)) if (!key.startsWith("_") && typeof value === "string" && value && !ID.test(value)) return clip(value);
  }
  const [table, hex = ""] = id.split(":");
  return `${table}:${hex.slice(0, 6)}…`;
}

/** Where the Data page is: a table, optionally narrowed by an index lookup, optionally with one document open. */
export type Place = { table: string; label: string; filter?: { index: string; eq: [string, unknown][] }; openId?: string };
export type Go = (to: Omit<Place, "label"> & { label?: string }) => void;
