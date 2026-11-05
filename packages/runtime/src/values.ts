import { z } from "zod";

declare const phantom: unique symbol;

export type Id<TableName extends string> = string & { readonly __tableName: TableName };

export type ValidatorKind = "string" | "number" | "boolean" | "null" | "id" | "array" | "object" | "union" | "literal" | "any";

/** What a validator says about its value for people: the OpenAPI document, the API docs page and the dashboard show it. Nothing here is checked. */
export interface ValidatorMeta {
  /** A sentence or two, markdown. */
  description?: string;
  title?: string;
  /** A typical value; the API docs use it in request and response examples. */
  example?: unknown;
  /** What applies when the value is left out. Documentation only: the engine doesn't fill it in. */
  default?: unknown;
  deprecated?: boolean;
  /**
   * The schema's name in the OpenAPI document (`components.schemas.<name>`), for an object (or any validator) that is one thing in your API,
   * like `"Price"`: every place that uses it refers to it by that name, which stays the same whatever else changes.
   */
  name?: string;
}

/** String formats the engine checks and documents. */
export type StringFormat = "email" | "uri" | "uuid" | "date-time" | "date";

/** Constraints, checked with every call and write like the kind is, and described in the OpenAPI document. */
export interface ValidatorChecks {
  /** Numbers: the smallest and largest allowed (inclusive), or bounds the value must be strictly inside of. */
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
  /** Numbers: a whole number. */
  int?: boolean;
  /** Strings: length in characters. */
  minLength?: number;
  maxLength?: number;
  /** Strings: a regular expression the whole string must match, as source text (so it can cross processes); anchor it yourself. */
  pattern?: string;
  format?: StringFormat;
  /** Arrays: how many elements, and whether they must all differ. */
  minItems?: number;
  maxItems?: number;
  unique?: boolean;
}

/** Plain data so schemas can cross process boundaries (dashboard, function runtime); compiled to Zod for validation. */
export interface Validator<T = unknown, IsOptional extends boolean = boolean> {
  readonly kind: ValidatorKind;
  readonly optional: IsOptional;
  readonly table?: string;
  readonly element?: Validator;
  readonly fields?: Record<string, Validator>;
  readonly members?: Validator[];
  /** A literal's value. */
  readonly value?: string | number | boolean;
  readonly meta?: ValidatorMeta;
  readonly checks?: ValidatorChecks;
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

export type StringOptions = ValidatorMeta & Pick<ValidatorChecks, "minLength" | "maxLength" | "pattern" | "format">;
export type NumberOptions = ValidatorMeta & Pick<ValidatorChecks, "min" | "max" | "exclusiveMin" | "exclusiveMax" | "int">;
export type ArrayOptions = ValidatorMeta & Pick<ValidatorChecks, "minItems" | "maxItems" | "unique">;

const META_KEYS = ["description", "title", "example", "default", "deprecated", "name"] as const;
const CHECK_KEYS = ["min", "max", "exclusiveMin", "exclusiveMax", "int", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "unique"] as const;

/** Splits builder options into what is said (meta) and what is checked; neither key is set when it would be empty, so plain validators stay as they were. */
function options(o: object | undefined): { meta?: ValidatorMeta; checks?: ValidatorChecks } {
  if (!o) return {};
  const pick = (keys: readonly string[]) => {
    const out = Object.fromEntries(keys.filter((k) => (o as Record<string, unknown>)[k] !== undefined).map((k) => [k, (o as Record<string, unknown>)[k]]));
    return Object.keys(out).length ? out : undefined;
  };
  const meta = pick(META_KEYS) as ValidatorMeta | undefined;
  const checks = pick(CHECK_KEYS) as ValidatorChecks | undefined;
  if (checks?.pattern !== undefined) new RegExp(checks.pattern, "u"); // a bad pattern fails where it is written, not at the first call
  if (checks) {
    const bad = Object.entries(checks).find(([k, x]) => ["min", "max", "exclusiveMin", "exclusiveMax"].includes(k) ? !Number.isFinite(x) : ["minLength", "maxLength", "minItems", "maxItems"].includes(k) ? !(Number.isInteger(x) && (x as number) >= 0) : false);
    if (bad) throw new Error(`${bad[0]} must be ${bad[0].startsWith("m") && bad[0].length > 3 ? "a whole number ≥ 0" : "a finite number"}, got ${bad[1]}`);
  }
  return { ...(meta && { meta }), ...(checks && { checks }) };
}

export const v = {
  /** `v.string({ minLength: 1, maxLength: 200, format: "email", description: "…", example: "ada@example.com" })`: every option is optional. */
  string: (opts?: StringOptions) => make<string>("string", options(opts)),
  /** `v.number({ min: 1, max: 100, int: true })`: bounds and whole numbers are checked; the rest documents. */
  number: (opts?: NumberOptions) => make<number>("number", options(opts)),
  boolean: (meta?: ValidatorMeta) => make<boolean>("boolean", options(meta)),
  null: (meta?: ValidatorMeta) => make<null>("null", options(meta)),
  id: <TableName extends string>(table: TableName, meta?: ValidatorMeta) => make<Id<TableName>>("id", { table, ...options(meta) }),
  array: <E extends Validator<any, false>>(element: E, opts?: ArrayOptions) => make<Infer<E>[]>("array", { element, ...options(opts) }),
  /** `v.object({ ... }, { name: "Price", description: "…" })`: a name makes it one schema in the OpenAPI document, referred to by that name. */
  object: <F extends PropertyValidators>(fields: F, meta?: ValidatorMeta) => make<ObjectType<F>>("object", { fields, ...options(meta) }),
  union: <M extends [Validator<any, false>, ...Validator<any, false>[]]>(...members: M) =>
    make<Infer<M[number]>>("union", { members }),
  /** Exactly this value: `v.literal("subscription")`. */
  literal: <const T extends string | number | boolean>(value: T, meta?: ValidatorMeta) => make<T>("literal", { value, ...options(meta) }),
  /** One of these strings: `v.enum("one_time", "subscription")`, a union of literals the OpenAPI document lists as an enum. */
  enum: <const T extends [string, ...string[]]>(...values: T) => {
    if (!values.length || new Set(values).size !== values.length) throw new Error("v.enum() takes one or more different strings");
    return make<T[number]>("union", { members: values.map((value) => make("literal", { value })) });
  },
  optional: <I extends Validator<any, false>>(inner: I) =>
    ({ ...inner, optional: true }) as Validator<Infer<I> | undefined, true>,
  /** The value, or null: present, but not set. (`v.optional` is a field that may be absent.) */
  nullable: <I extends Validator<any, false>>(inner: I) => {
    const { meta, ...rest } = inner as Validator;
    return make<Infer<I> | null>("union", { members: [rest, make("null")], ...(meta && { meta }) });
  },
  /**
   * Any JSON value, unchecked. For data whose shape is not yours to fix, such as the JSON fields Better Auth's plugins write (`metadata`,
   * `customClaims`); anything you define yourself is better described.
   */
  any: (meta?: ValidatorMeta) => make<any>("any", options(meta)),
  /** The same validator with documentation added: `v.describe(v.enum("a", "b"), { description: "…" })`, for those built without options. */
  describe: <V extends Validator<any, any>>(validator: V, meta: ValidatorMeta): V => {
    const { meta: added } = options(meta);
    return { ...validator, ...(added && { meta: { ...validator.meta, ...added } }) };
  },
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
  const c = validator.checks;
  switch (validator.kind) {
    case "string":
      schema = c ? stringChecks(c) : z.string({ error: expected("a string") });
      break;
    case "number":
      schema = c ? numberChecks(c) : z.number({ error: expected("a finite number") });
      break;
    case "literal":
      schema = z.literal(validator.value!, { error: expected(JSON.stringify(validator.value)) });
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
    case "array": {
      let a = z.array(toZod(validator.element!), { error: expected("an array") });
      if (c?.minItems !== undefined) a = a.min(c.minItems, { error: (i) => `must have at least ${c.minItems} item${c.minItems === 1 ? "" : "s"}, got ${(i.input as unknown[]).length}` });
      if (c?.maxItems !== undefined) a = a.max(c.maxItems, { error: (i) => `must have at most ${c.maxItems} item${c.maxItems === 1 ? "" : "s"}, got ${(i.input as unknown[]).length}` });
      schema = c?.unique ? a.refine((items) => new Set(items.map((x) => JSON.stringify(x))).size === items.length, { error: "must not repeat an item" }) : a;
      break;
    }
    case "object":
      schema = objectSchema(validator.fields!);
      break;
    case "any":
      schema = z.any();
      break;
    case "union":
      schema = z.union(validator.members!.map(toZod) as [z.ZodType, ...z.ZodType[]], {
        error: expected(`one of ${validator.members!.map((m) => (m.kind === "literal" ? JSON.stringify(m.value) : m.kind)).join(" | ")}`),
      });
      break;
  }
  if (validator.optional) schema = schema!.optional();
  compiled.set(validator, schema!);
  return schema!;
}

const FORMATS: Record<StringFormat, { what: string; schema: () => z.ZodString | z.ZodType }> = {
  email: { what: "an email address", schema: () => z.email() },
  uri: { what: "an absolute URL", schema: () => z.url() },
  uuid: { what: "a UUID", schema: () => z.uuid() },
  "date-time": { what: "an ISO 8601 date and time (like 2026-01-31T12:00:00Z)", schema: () => z.iso.datetime({ offset: true }) },
  date: { what: "a date (YYYY-MM-DD)", schema: () => z.iso.date() },
};

function stringChecks(c: ValidatorChecks): z.ZodType {
  const base = z.string({ error: expected("a string") });
  const len = (s: unknown) => (typeof s === "string" ? [...s].length : 0);
  const quoted = (s: unknown) => JSON.stringify(typeof s === "string" && s.length > 60 ? `${s.slice(0, 57)}...` : s);
  const pattern = c.pattern === undefined ? undefined : new RegExp(c.pattern, "u");
  const format = c.format && FORMATS[c.format];
  // One refinement in a fixed order, so the message names the first rule broken, as for every other check.
  return base.superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (c.minLength !== undefined && len(s) < c.minLength) return fail(c.minLength === 1 ? "must not be empty" : `must be at least ${c.minLength} characters, got ${len(s)}`);
    if (c.maxLength !== undefined && len(s) > c.maxLength) return fail(`must be at most ${c.maxLength} characters, got ${len(s)}`);
    if (pattern && !pattern.test(s)) return fail(`must match ${c.pattern}, got ${quoted(s)}`);
    if (format && !format.schema().safeParse(s).success) return fail(`must be ${format.what}, got ${quoted(s)}`);
  });
}

function numberChecks(c: ValidatorChecks): z.ZodType {
  return z.number({ error: expected("a finite number") }).superRefine((n, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (c.int && !Number.isInteger(n)) return fail(`must be a whole number, got ${n}`);
    if (c.min !== undefined && n < c.min) return fail(`must be at least ${c.min}, got ${n}`);
    if (c.max !== undefined && n > c.max) return fail(`must be at most ${c.max}, got ${n}`);
    if (c.exclusiveMin !== undefined && n <= c.exclusiveMin) return fail(`must be more than ${c.exclusiveMin}, got ${n}`);
    if (c.exclusiveMax !== undefined && n >= c.exclusiveMax) return fail(`must be less than ${c.exclusiveMax}, got ${n}`);
  });
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

/** Args validator for paginated queries: `args: { paginationOpts: paginationOptsValidator }`. Takes cursors and numbered pages (`offset`, `withTotal`). */
export const paginationOptsValidator = v.object({ numItems: v.number(), cursor: v.union(v.string(), v.null()), offset: v.optional(v.number()), withTotal: v.optional(v.boolean()) });
