// What the page says about a JSON Schema: its type, enum, constraints and children for the attribute tables, and a value that fits it for
// examples. References are followed through the document, and recursion stops where a schema contains itself.
import { deref, lookup, refName, type MediaType, type OpenApi, type Schema } from "./openapi";

export type ConstraintKey =
  | "format"
  | "minimum"
  | "maximum"
  | "exclusiveMinimum"
  | "exclusiveMaximum"
  | "multipleOf"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "minItems"
  | "maxItems"
  | "uniqueItems"
  | "minProperties"
  | "maxProperties";

export interface Info {
  /** The schema with references and `allOf` resolved. */
  schema: Schema;
  /** The component it came from, when it came from one. */
  name?: string;
  /** For display: `string`, `integer`, `Payment`, `array<Payment>`, `map<string, integer>`, `Card | Bank`. */
  type: string;
  nullable: boolean;
  enumValues?: { value: unknown; description?: string }[];
  constraints: [ConstraintKey, string][];
  default?: unknown;
  hasDefault: boolean;
  example?: unknown;
  hasExample: boolean;
  deprecated: boolean;
  readOnly: boolean;
  writeOnly: boolean;
  description?: string;
  /** What can be opened under it: an object's properties (an array's items' too) or the variants of a union. */
  children?: { kind: "props"; props: [string, Schema][]; required: Set<string>; of: string | undefined } | { kind: "variants"; variants: Schema[] };
  /** A component it contains again (the nested table stops here). */
  seen: string[];
}

const isNull = (s: Schema | undefined) => !!s && (s.type === "null" || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === "null") || (s.const === null && !s.type));

/** `allOf` members folded into one schema; the schema's own keys win. */
function merge(doc: OpenApi, s: Schema, depth = 0): Schema {
  if (!s.allOf || depth > 8) return s;
  const { allOf, ...own } = s;
  let acc: Schema = {};
  for (const member of allOf) {
    const m = merge(doc, deref(doc, member) ?? {}, depth + 1);
    acc = { ...acc, ...m, properties: { ...acc.properties, ...m.properties }, required: [...(acc.required ?? []), ...(m.required ?? [])] };
    if (!Object.keys(acc.properties ?? {}).length) delete acc.properties;
    if (!acc.required?.length) delete acc.required;
  }
  const merged = { ...acc, ...own, properties: { ...acc.properties, ...own.properties }, required: [...(acc.required ?? []), ...(own.required ?? [])] };
  if (!Object.keys(merged.properties).length) delete (merged as Schema).properties;
  if (!merged.required.length) delete (merged as Schema).required;
  return merged as Schema;
}

/** A schema resolved: its references followed (naming the first component on the way), `allOf` merged, a nullable union reduced to its member. */
export function resolve(doc: OpenApi, schema: Schema | undefined, seen: string[] = []): { schema: Schema; name?: string; nullable: boolean; seen: string[] } {
  let s: Schema = schema ?? {};
  let name: string | undefined;
  let nullable = false;
  const chain = [...seen];
  for (let i = 0; i < 12; i++) {
    if (s.$ref) {
      const n = refName(s.$ref);
      name ??= n;
      chain.push(n);
      const { $ref, ...beside } = s;
      s = { ...(lookup<Schema>(doc, $ref) ?? {}), ...beside };
      continue;
    }
    s = merge(doc, s);
    const union = s.anyOf ?? s.oneOf;
    if (union?.some(isNull)) {
      const rest = union.filter((m) => !isNull(m));
      nullable = true;
      if (rest.length === 1) {
        const { anyOf, oneOf, ...own } = s;
        s = { ...(rest[0] as Schema), ...own }; // a reference stays one, with the union's own keys beside it
        continue;
      }
      s = { ...s, [s.anyOf ? "anyOf" : "oneOf"]: rest };
    }
    break;
  }
  if (s.nullable === true || (Array.isArray(s.type) && s.type.includes("null"))) nullable = true;
  return { schema: s, name, nullable, seen: chain };
}

const baseType = (s: Schema): string | undefined => (Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type);

export function describe(doc: OpenApi, schema: Schema | undefined, seen: string[] = []): Info {
  const r = resolve(doc, schema, seen);
  const s = r.schema;
  const variants = (s.anyOf ?? s.oneOf)?.filter((m) => !isNull(m));
  let t = baseType(s);
  if (!t) t = s.properties ? "object" : s.items ? "array" : s.enum ? typeOfValue(s.enum[0]) : s.const !== undefined ? typeOfValue(s.const) : undefined;
  let type = t ?? "any";
  let children: Info["children"];
  const propsOf = (o: Schema, of: string | undefined): Info["children"] =>
    o.properties && Object.keys(o.properties).length ? { kind: "props", props: Object.entries(o.properties), required: new Set(o.required ?? []), of } : undefined;
  if (variants && variants.length > 1) {
    type = variants.map((m) => describe(doc, m, r.seen).type).join(" | ");
    children = { kind: "variants", variants };
  } else if (t === "array") {
    const item = describe(doc, s.items, r.seen);
    type = `array<${item.type}>`;
    children = item.children;
  } else if (t === "object") {
    if (r.name) type = r.name;
    else if (s.additionalProperties && typeof s.additionalProperties === "object" && !s.properties) type = `map<string, ${describe(doc, s.additionalProperties, r.seen).type}>`;
    children = propsOf(s, r.name);
  } else if (r.name && !s.enum) {
    type = t ?? r.name;
  }
  const constraints: Info["constraints"] = [];
  const add = (k: ConstraintKey, v: unknown) => v !== undefined && v !== false && constraints.push([k, String(v)]);
  add("format", s.format);
  // OpenAPI 3.0 wrote exclusiveMinimum as a boolean beside minimum; 3.1 as a number of its own.
  if (typeof s.exclusiveMinimum === "number") add("exclusiveMinimum", s.exclusiveMinimum);
  else add(s.exclusiveMinimum === true ? "exclusiveMinimum" : "minimum", s.minimum);
  if (typeof s.exclusiveMaximum === "number") add("exclusiveMaximum", s.exclusiveMaximum);
  else add(s.exclusiveMaximum === true ? "exclusiveMaximum" : "maximum", s.maximum);
  add("multipleOf", s.multipleOf);
  add("minLength", s.minLength);
  add("maxLength", s.maxLength);
  add("pattern", s.pattern);
  add("minItems", s.minItems);
  add("maxItems", s.maxItems);
  add("uniqueItems", s.uniqueItems);
  add("minProperties", s.minProperties);
  add("maxProperties", s.maxProperties);
  const itemEnum = t === "array" ? resolve(doc, s.items, r.seen).schema.enum : undefined;
  const values = s.enum ?? (s.const !== undefined ? [s.const] : itemEnum);
  const notes = s["x-enumDescriptions"];
  const enumValues = values?.map((value, i) => ({ value, description: Array.isArray(notes) ? notes[i] : notes?.[String(value)] }));
  return {
    schema: s,
    name: r.name,
    type,
    nullable: r.nullable,
    enumValues,
    constraints,
    default: s.default,
    hasDefault: "default" in s,
    example: s.example ?? (Array.isArray(s.examples) ? s.examples[0] : undefined),
    hasExample: s.example !== undefined || (Array.isArray(s.examples) && s.examples.length > 0),
    deprecated: s.deprecated === true,
    readOnly: s.readOnly === true,
    writeOnly: s.writeOnly === true,
    description: s.description,
    children,
    seen: r.seen,
  };
}

function typeOfValue(v: unknown): string {
  return typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v === "boolean" ? "boolean" : v === null ? "null" : typeof v === "object" ? (Array.isArray(v) ? "array" : "object") : "string";
}

const FORMATS: Record<string, string> = {
  "date-time": "2026-01-15T10:30:00Z",
  date: "2026-01-15",
  time: "10:30:00Z",
  duration: "P1D",
  email: "user@example.com",
  uri: "https://example.com",
  url: "https://example.com",
  "uri-reference": "/resource",
  uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  hostname: "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  byte: "U3dhZ2dlciByb2Nrcw==",
  binary: "(binary)",
  password: "********",
  "json-pointer": "/a/b",
};

/** A value that fits the schema: the example it gives, else its default, its first enum value, else something made from its type and limits. */
export function exampleOf(doc: OpenApi, schema: Schema | undefined, mode: "request" | "response" = "response", depth = 0, seen: string[] = []): unknown {
  const r = resolve(doc, schema, seen);
  const s = r.schema;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  const variants = (s.anyOf ?? s.oneOf)?.filter((m) => !isNull(m));
  if (variants?.length) return exampleOf(doc, variants[0], mode, depth, r.seen);
  const t = baseType(s) ?? (s.properties ? "object" : s.items ? "array" : undefined);
  if (depth > 5) return t === "array" ? [] : t === "object" ? {} : null;
  switch (t) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(s.properties ?? {})) {
        const d = resolve(doc, p, r.seen).schema;
        if ((mode === "request" && d.readOnly) || (mode === "response" && d.writeOnly)) continue;
        if (r.seen.includes(refName((p as Schema).$ref ?? "")) && !(s.required ?? []).includes(k)) continue; // a cycle through an optional field
        out[k] = exampleOf(doc, p, mode, depth + 1, r.seen);
      }
      if (!Object.keys(out).length && s.additionalProperties && typeof s.additionalProperties === "object") out.key = exampleOf(doc, s.additionalProperties, mode, depth + 1, r.seen);
      return out;
    }
    case "array":
      return r.seen.length > 6 ? [] : [exampleOf(doc, s.items, mode, depth + 1, r.seen)];
    case "integer":
    case "number": {
      const min = typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum + 1 : s.minimum;
      const max = typeof s.exclusiveMaximum === "number" ? s.exclusiveMaximum - 1 : s.maximum;
      let n = min ?? (max !== undefined && max < 1 ? max : 1);
      if (max !== undefined && n > max) n = max;
      if (s.multipleOf && n % s.multipleOf) n = Math.ceil(n / s.multipleOf) * s.multipleOf;
      return n;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    case "string": {
      if (s.format && FORMATS[s.format]) return FORMATS[s.format];
      const id = /^\^?([A-Za-z_]\w*):/.exec(s.pattern ?? ""); // the engine's ids: `^table:`
      if (id) return `${id[1]}:0123456789abcdef0123456789abcdef`;
      let text = "string";
      if (s.minLength && text.length < s.minLength) text = text.padEnd(s.minLength, "x");
      if (s.maxLength !== undefined) text = text.slice(0, s.maxLength);
      return text;
    }
    default:
      return null;
  }
}

/** The example a media type carries (`example`, else the first of `examples`), else one made from its schema. */
export function mediaExample(doc: OpenApi, media: MediaType | undefined, mode: "request" | "response"): unknown {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  const first = Object.values(media.examples ?? {})[0];
  const given = first ? deref(doc, first as { $ref?: string; value?: unknown }) : undefined;
  if (given && "value" in given) return given.value;
  return media.schema ? exampleOf(doc, media.schema, mode) : undefined;
}

/** How a value reads in a chip: strings and primitives as JSON, objects compact. */
export function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
