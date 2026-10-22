import { z } from "zod";

declare const phantom: unique symbol;

export type Id<TableName extends string> = string & { readonly __tableName: TableName };

export type ValidatorKind = "string" | "number" | "boolean" | "null" | "id" | "array" | "object" | "union";

/** Plain data so schemas can cross process boundaries (dashboard, function runtime); compiled to Zod for validation. */
export interface Validator<T = unknown, IsOptional extends boolean = boolean> {
  readonly kind: ValidatorKind;
  readonly optional: IsOptional;
  readonly table?: string;
  readonly element?: Validator;
  readonly fields?: Record<string, Validator>;
  readonly members?: Validator[];
  readonly [phantom]?: T;
}

export type PropertyValidators = Record<string, Validator<any, boolean>>;

export type Infer<V extends Validator<any, any>> = V extends Validator<infer T, any> ? T : never;

export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

type OptionalKeys<F> = { [K in keyof F]: F[K] extends Validator<any, true> ? K : never }[keyof F];
type RequiredKeys<F> = Exclude<keyof F, OptionalKeys<F>>;

export type ObjectType<F extends PropertyValidators> = Expand<
  { [K in RequiredKeys<F>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Infer<F[K]> }
>;

const make = <T>(kind: ValidatorKind, extra: object = {}) =>
  ({ kind, optional: false, ...extra }) as Validator<T, false>;

export const v = {
  string: () => make<string>("string"),
  number: () => make<number>("number"),
  boolean: () => make<boolean>("boolean"),
  null: () => make<null>("null"),
  id: <TableName extends string>(table: TableName) => make<Id<TableName>>("id", { table }),
  array: <E extends Validator<any, false>>(element: E) => make<Infer<E>[]>("array", { element }),
  object: <F extends PropertyValidators>(fields: F) => make<ObjectType<F>>("object", { fields }),
  union: <M extends [Validator<any, false>, ...Validator<any, false>[]]>(...members: M) =>
    make<Infer<M[number]>>("union", { members }),
  optional: <I extends Validator<any, false>>(inner: I) =>
    ({ ...inner, optional: true }) as Validator<Infer<I> | undefined, true>,
};

export class ValidationError extends Error {
  override name = "ValidationError";
}

/** The table an id belongs to. Ids look like `<table>:<32 hex>`. */
export function tableOf(id: string): string {
  return id.slice(0, id.indexOf(":"));
}

// ---- Zod compilation ----

const expected = (what: string) => (iss: { input?: unknown }) =>
  iss.input === undefined ? "is required" : `must be ${what}, got ${JSON.stringify(iss.input) ?? typeof iss.input}`;

const compiled = new WeakMap<Validator, z.ZodType>();

/** The Zod schema for a validator, cached per validator object. */
export function toZod(validator: Validator): z.ZodType {
  let schema = compiled.get(validator);
  if (schema) return schema;
  switch (validator.kind) {
    case "string":
      schema = z.string({ error: expected("a string") });
      break;
    case "number":
      schema = z.number({ error: expected("a finite number") });
      break;
    case "boolean":
      schema = z.boolean({ error: expected("a boolean") });
      break;
    case "null":
      schema = z.null({ error: expected("null") });
      break;
    case "id": {
      const what = `an Id<"${validator.table}">`;
      schema = z.string({ error: expected(what) }).refine((s) => tableOf(s) === validator.table, { error: expected(what) });
      break;
    }
    case "array":
      schema = z.array(toZod(validator.element!), { error: expected("an array") });
      break;
    case "object":
      schema = objectSchema(validator.fields!);
      break;
    case "union":
      schema = z.union(validator.members!.map(toZod) as [z.ZodType, ...z.ZodType[]], {
        error: expected(`one of ${validator.members!.map((m) => m.kind).join(" | ")}`),
      });
      break;
  }
  if (validator.optional) schema = schema!.optional();
  compiled.set(validator, schema!);
  return schema!;
}

const objectSchemas = new WeakMap<Record<string, Validator>, z.ZodType>();

function objectSchema(fields: Record<string, Validator>) {
  let schema = objectSchemas.get(fields);
  if (!schema) {
    schema = z.strictObject(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, toZod(f)])), { error: expected("an object") });
    objectSchemas.set(fields, schema);
  }
  return schema;
}

const formatPath = (base: string, path: PropertyKey[]) =>
  base + path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");

function check(schema: z.ZodType, value: unknown, path: string) {
  const result = schema.safeParse(value);
  if (result.success) return;
  const issue = result.error.issues[0]!;
  if (issue.code === "unrecognized_keys")
    throw new ValidationError(`${formatPath(path, [...issue.path, issue.keys[0]!])} is not in the validator`);
  throw new ValidationError(`${formatPath(path, issue.path)} ${issue.message}`);
}

export function validate(validator: Validator, value: unknown, path = "value"): void {
  check(toZod(validator), value, path);
}

/** Validates a document or an args object. Keys set to undefined count as absent. */
export function validateFields(fields: Record<string, Validator>, value: Record<string, unknown>, path = "value") {
  const defined = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, x]) => x !== undefined))
    : value;
  check(objectSchema(fields), defined, path);
}
