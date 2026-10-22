declare const phantom: unique symbol;

export type Id<TableName extends string> = string & { readonly __tableName: TableName };

export type ValidatorKind = "string" | "number" | "boolean" | "id" | "array" | "object";

/** Plain data so schemas can cross process boundaries (dashboard, function runtime). */
export interface Validator<T = unknown, IsOptional extends boolean = boolean> {
  readonly kind: ValidatorKind;
  readonly optional: IsOptional;
  readonly table?: string;
  readonly element?: Validator;
  readonly fields?: Record<string, Validator>;
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
  id: <TableName extends string>(table: TableName) => make<Id<TableName>>("id", { table }),
  array: <E extends Validator<any, false>>(element: E) => make<Infer<E>[]>("array", { element }),
  object: <F extends PropertyValidators>(fields: F) => make<ObjectType<F>>("object", { fields }),
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

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && Object.getPrototypeOf(x) === Object.prototype;

export function validate(validator: Validator, value: unknown, path = "value"): void {
  if (value === undefined) {
    if (validator.optional) return;
    throw new ValidationError(`${path} is required`);
  }
  const fail = (expected: string) => {
    throw new ValidationError(`${path} must be ${expected}, got ${JSON.stringify(value) ?? typeof value}`);
  };
  switch (validator.kind) {
    case "string":
      if (typeof value !== "string") fail("a string");
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("a finite number");
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("a boolean");
      return;
    case "id":
      if (typeof value !== "string" || tableOf(value) !== validator.table) fail(`an Id<"${validator.table}">`);
      return;
    case "array":
      if (!Array.isArray(value)) fail("an array");
      (value as unknown[]).forEach((el, i) => validate(validator.element!, el, `${path}[${i}]`));
      return;
    case "object":
      if (!isPlainObject(value)) fail("an object");
      validateFields(validator.fields!, value as Record<string, unknown>, path);
      return;
  }
}

export function validateFields(fields: Record<string, Validator>, value: Record<string, unknown>, path = "value") {
  if (!isPlainObject(value)) throw new ValidationError(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (!(key in fields) && value[key] !== undefined) throw new ValidationError(`${path}.${key} is not in the validator`);
  }
  for (const [key, field] of Object.entries(fields)) validate(field, value[key], `${path}.${key}`);
}
