import { v, type Expand, type Id, type ObjectType, type PropertyValidators } from "./values";

export type Indexes = Record<string, readonly string[]>;

export interface TableDefinition<F extends PropertyValidators = PropertyValidators, I extends Indexes = Indexes> {
  readonly fields: F;
  readonly indexes: I;
  /** false for tables owned by Better Auth, whose plugins may add fields. */
  readonly strict: boolean;
  index<const N extends string, const Fs extends readonly [keyof F & string, ...(keyof F & string)[]]>(
    name: N,
    fields: Fs,
  ): TableDefinition<F, Expand<I & Record<N, Fs>>>;
}

export function defineTable<F extends PropertyValidators>(fields: F): TableDefinition<F, {}> {
  const table = (indexes: Indexes, strict: boolean): TableDefinition<any, any> => ({
    fields,
    indexes,
    strict,
    index: (name, idxFields) => table({ ...indexes, [name]: idxFields }, strict),
  });
  return table({}, true);
}

const loose = <T extends TableDefinition<any, any>>(t: T): T => ({ ...t, strict: false });

/** Better Auth's core models. Dates are stored as epoch milliseconds. */
export const authTables = {
  users: loose(
    defineTable({
      name: v.string(),
      email: v.string(),
      emailVerified: v.boolean(),
      image: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_email", ["email"]),
  ),
  sessions: loose(
    defineTable({
      userId: v.id("users"),
      token: v.string(),
      expiresAt: v.number(),
      ipAddress: v.optional(v.string()),
      userAgent: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_token", ["token"])
      .index("by_userId", ["userId"]),
  ),
  accounts: loose(
    defineTable({
      userId: v.id("users"),
      accountId: v.string(),
      providerId: v.string(),
      accessToken: v.optional(v.string()),
      refreshToken: v.optional(v.string()),
      idToken: v.optional(v.string()),
      accessTokenExpiresAt: v.optional(v.number()),
      refreshTokenExpiresAt: v.optional(v.number()),
      scope: v.optional(v.string()),
      password: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_userId", ["userId"])
      .index("by_accountId", ["accountId"]),
  ),
  verifications: loose(
    defineTable({
      identifier: v.string(),
      value: v.string(),
      expiresAt: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_identifier", ["identifier"]),
  ),
};

export const systemTables = {
  _storage: defineTable({ key: v.string(), contentType: v.optional(v.string()) }),
};

export type BuiltinTables = typeof authTables & typeof systemTables;

export interface SchemaDefinition<T extends Record<string, TableDefinition<any, any>>> {
  readonly tables: T;
}

const IDENT = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function defineSchema<T extends Record<string, TableDefinition<any, any>>>(
  tables: T & { [K in keyof BuiltinTables]?: never },
): SchemaDefinition<T & BuiltinTables> {
  for (const [name, table] of Object.entries(tables)) {
    if (name in authTables || name in systemTables)
      throw new Error(`Table "${name}" is reserved (Better Auth / system). Store extra user data in a separate table keyed by userId.`);
    if (!IDENT.test(name)) throw new Error(`Table name "${name}" must match ${IDENT}`);
    for (const field of Object.keys(table.fields))
      if (!IDENT.test(field)) throw new Error(`Field "${name}.${field}" must match ${IDENT}`);
    for (const [index, fields] of Object.entries(table.indexes as Indexes)) {
      if (!IDENT.test(index) || index === "by_id") throw new Error(`Index name "${name}.${index}" is invalid or reserved`);
      for (const f of fields) if (!(f in table.fields)) throw new Error(`Index "${name}.${index}" uses unknown field "${f}"`);
    }
  }
  return { tables: { ...tables, ...authTables, ...systemTables } as T & BuiltinTables };
}

// ---- type-level data model, bound to the user's schema by codegen via `Register` ----

/** Augmented by `convex/_generated/dataModel.ts`: `interface Register { schema: typeof schema }`. */
export interface Register {}

export type GenericTables = Record<string, TableDefinition<any, any>>;

export type RegisteredTables = Register extends { schema: SchemaDefinition<infer T> } ? T : GenericTables;

export type TableNames = keyof RegisteredTables & string;

export type SystemFields<T extends string> = { _id: Id<T>; _creationTime: number };

export type Doc<T extends TableNames> = Expand<SystemFields<T> & ObjectType<RegisteredTables[T]["fields"]>>;

export type WithoutSystemFields<D> = Expand<Omit<D, "_id" | "_creationTime">>;

export type IndexNames<T extends TableNames> = keyof RegisteredTables[T]["indexes"] & string;

export type IndexFields<T extends TableNames, I extends IndexNames<T>> = RegisteredTables[T]["indexes"][I];
