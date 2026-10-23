import type { Validator } from "./values";

/** A reference from one table's field to another table, read off `v.id(...)`. */
export interface Relation {
  table: string;
  field: string;
  target: string;
  /** The field holds an array of ids. */
  many: boolean;
  optional: boolean;
}

/** What a field refers to: `v.id("lists")` (optionally wrapped in `v.optional`) or `v.array(v.id("lists"))`. Nested objects and unions don't count. */
export function referenceOf(validator: Pick<Validator, "kind" | "table" | "element">): { target: string; many: boolean } | undefined {
  if (validator.kind === "id" && validator.table) return { target: validator.table, many: false };
  if (validator.kind === "array" && validator.element?.kind === "id" && validator.element.table) return { target: validator.element.table, many: true };
  return undefined;
}

type TableLike = { fields: Record<string, Validator>; indexes: Record<string, readonly string[]> };

/** Every reference in the schema, in table and field order. */
export function relationsOf(tables: Record<string, TableLike>): Relation[] {
  return Object.entries(tables).flatMap(([table, t]) =>
    Object.entries(t.fields).flatMap(([field, validator]) => {
      const ref = referenceOf(validator);
      return ref ? [{ table, field, target: ref.target, many: ref.many, optional: validator.optional }] : [];
    }),
  );
}

/** The index to find documents by a reference field: one that starts with it. Arrays can't be looked up this way. */
export function indexFor(t: TableLike, field: string): string | undefined {
  if (t.fields[field]?.kind === "array") return undefined;
  return Object.entries(t.indexes).find(([, fields]) => fields[0] === field)?.[0];
}
