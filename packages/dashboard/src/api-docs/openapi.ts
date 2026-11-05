// The OpenAPI document as the page reads it: loose types for the parts it shows, references resolved, and the document arranged into what the
// page lays out (guides aside): tag sections in groups, webhook events, named models and security schemes. No React in here.
import type { WebhooksSigning } from "./contract";

export interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown;
  nullable?: boolean;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  /** What an enum's values mean: an array in the same order or an object by value (the extension Redoc, Scalar and others read). */
  "x-enumDescriptions"?: string[] | Record<string, string>;
  [extension: `x-${string}`]: unknown;
}

export interface MediaType {
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, { summary?: string; value?: unknown }>;
}
export interface Parameter {
  $ref?: string;
  name: string;
  in: "query" | "path" | "header" | "cookie";
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  content?: Record<string, MediaType>;
}
export interface HeaderObject {
  $ref?: string;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: Schema;
  example?: unknown;
}
export interface RequestBody {
  $ref?: string;
  description?: string;
  required?: boolean;
  content?: Record<string, MediaType>;
}
export interface ResponseObject {
  $ref?: string;
  description?: string;
  headers?: Record<string, HeaderObject>;
  content?: Record<string, MediaType>;
}
export type SecurityRequirement = Record<string, string[]>;
export interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, ResponseObject>;
  security?: SecurityRequirement[];
  servers?: { url: string; description?: string }[];
  "x-codeSamples"?: { lang: string; label?: string; source: string }[];
  "x-error-codes"?: { status: string; code: string; description?: string }[];
  "x-scopes"?: string[];
  "x-internal"?: boolean;
}
export interface PathItem {
  $ref?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  servers?: { url: string; description?: string }[];
  [method: string]: unknown;
}
export interface OAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}
export interface SecurityScheme {
  $ref?: string;
  type: "http" | "apiKey" | "oauth2" | "openIdConnect" | "mutualTLS";
  description?: string;
  scheme?: string;
  bearerFormat?: string;
  name?: string;
  in?: "query" | "header" | "cookie";
  flows?: { implicit?: OAuthFlow; password?: OAuthFlow; clientCredentials?: OAuthFlow; authorizationCode?: OAuthFlow };
  openIdConnectUrl?: string;
}
export interface Tag {
  name: string;
  description?: string;
  "x-displayName"?: string;
  externalDocs?: { url: string; description?: string };
}
export interface OpenApi {
  openapi?: string;
  info: {
    title: string;
    version: string;
    summary?: string;
    description?: string;
    termsOfService?: string;
    contact?: { name?: string; url?: string; email?: string };
    license?: { name: string; url?: string; identifier?: string };
  };
  servers?: { url: string; description?: string; variables?: Record<string, { default: string; enum?: string[] }> }[];
  tags?: Tag[];
  paths?: Record<string, PathItem>;
  webhooks?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, Schema>;
    parameters?: Record<string, Parameter>;
    headers?: Record<string, HeaderObject>;
    responses?: Record<string, ResponseObject>;
    requestBodies?: Record<string, RequestBody>;
    securitySchemes?: Record<string, SecurityScheme>;
    pathItems?: Record<string, PathItem>;
  };
  security?: SecurityRequirement[];
  "x-tagGroups"?: { name: string; tags: string[] }[];
  "x-webhooks-signing"?: WebhooksSigning;
}

export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** The name at the end of a local reference: `#/components/schemas/Payment` is "Payment". */
export const refName = (ref: string) => decodeURIComponent(ref.slice(ref.lastIndexOf("/") + 1));

/** A local reference's target (`#/components/...`), or undefined when it points elsewhere or nowhere. */
export function lookup<T>(doc: OpenApi, ref: string): T | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let at: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at as T | undefined;
}

/** Follows `$ref` (and keeps the keys written beside it, which OpenAPI 3.1 allows to override). */
export function deref<T extends { $ref?: string }>(doc: OpenApi, value: T | undefined): T | undefined {
  let v = value;
  for (let i = 0; v?.$ref && i < 10; i++) {
    const { $ref, ...beside } = v;
    const target = lookup<T>(doc, $ref);
    if (!target) return beside as T;
    v = { ...target, ...beside };
  }
  return v;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

export interface OpEntry {
  /** The element id and hash: `/<tag>/<operationId>`. */
  id: string;
  path: string;
  method: string;
  operationId: string;
  op: Operation;
  pathItem: PathItem;
  /** The tag name the operation is listed under. */
  tag: string;
  internal: boolean;
}
export interface TagSection {
  id: string;
  name: string;
  title: string;
  description?: string;
  externalDocs?: Tag["externalDocs"];
  ops: OpEntry[];
}
export interface WebhookEntry {
  id: string;
  name: string;
  method: string;
  op: Operation;
}
export interface ModelEntry {
  id: string;
  name: string;
  schema: Schema;
}

/** The document arranged for the page. */
export interface Arranged {
  groups: { name: string | null; tags: TagSection[] }[];
  tags: TagSection[];
  ops: OpEntry[];
  webhooks: WebhookEntry[];
  models: ModelEntry[];
  schemes: [string, SecurityScheme][];
  hasRpc: boolean;
}

/** The operation's parameters: the path item's and its own, references followed, its own winning on the same name and location. */
export function parametersOf(doc: OpenApi, e: Pick<OpEntry, "op" | "pathItem">): Parameter[] {
  const out = new Map<string, Parameter>();
  for (const p of [...(e.pathItem.parameters ?? []), ...(e.op.parameters ?? [])]) {
    const r = deref(doc, p);
    if (r?.name) out.set(`${r.in}:${r.name}`, r);
  }
  return [...out.values()];
}

/** Ids that belong to the page's own sections, so a tag can't take them. */
const RESERVED = new Set(["introduction", "authentication", "webhooks", "models", "g"]);

/** Arranges the document: tags (declared ones first, in order) in `x-tagGroups` or, without them, one unnamed group, then the rest. */
export function arrange(doc: OpenApi, untagged: string, otherGroup: string): Arranged {
  const found: Omit<OpEntry, "id">[] = [];
  const byTag = new Map<string, Omit<OpEntry, "id">[]>();
  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const pathItem = deref(doc, rawItem as PathItem) ?? ({} as PathItem);
    for (const method of METHODS) {
      const op = pathItem[method] as Operation | undefined;
      if (!op || typeof op !== "object") continue;
      const tag = op.tags?.[0] ?? untagged;
      const entry = { path, method, operationId: op.operationId ?? `${method}-${slug(path)}`, op, pathItem, tag, internal: op["x-internal"] === true };
      found.push(entry);
      byTag.set(tag, [...(byTag.get(tag) ?? []), entry]);
    }
  }
  const declared = new Map((doc.tags ?? []).map((t) => [t.name, t]));
  const names = [...new Set([...declared.keys(), ...byTag.keys()])].filter((n) => byTag.has(n));
  const taken = new Set<string>();
  const used = new Set<string>();
  const sections = new Map<string, TagSection>();
  const ops: OpEntry[] = [];
  for (const name of names) {
    let key = slug(name);
    while (RESERVED.has(key) || taken.has(key)) key += "-";
    taken.add(key);
    const d = declared.get(name);
    const section: TagSection = { id: `/${key}`, name, title: d?.["x-displayName"] ?? name, description: d?.description, externalDocs: d?.externalDocs, ops: [] };
    for (const e of byTag.get(name)!) {
      const base = `${section.id}/${e.operationId.replace(/[^\w.:~-]+/g, "-")}`;
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      const entry = { ...e, id };
      section.ops.push(entry);
      ops.push(entry);
    }
    sections.set(name, section);
  }
  const placed = new Set<string>();
  const groups: Arranged["groups"] = [];
  for (const g of doc["x-tagGroups"] ?? []) {
    const tags = g.tags.filter((n) => sections.has(n) && !placed.has(n)).map((n) => (placed.add(n), sections.get(n)!));
    if (tags.length) groups.push({ name: g.name, tags });
  }
  const rest = [...sections.values()].filter((s) => !placed.has(s.name));
  if (rest.length) groups.push({ name: groups.length ? otherGroup : null, tags: rest });
  const webhooks: WebhookEntry[] = [];
  for (const [name, rawItem] of Object.entries(doc.webhooks ?? {})) {
    const item = deref(doc, rawItem) ?? ({} as PathItem);
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (op && typeof op === "object") webhooks.push({ id: `/webhooks/${slug(name)}`, name, method, op });
    }
  }
  const models = Object.entries(doc.components?.schemas ?? {}).map(([name, schema]) => ({ id: `/models/${slug(name)}`, name, schema }));
  return {
    groups,
    tags: groups.flatMap((g) => g.tags),
    ops,
    webhooks,
    models,
    schemes: Object.entries(doc.components?.securitySchemes ?? {}).map(([name, s]) => [name, deref(doc, s) ?? s] as [string, SecurityScheme]),
    hasRpc: Object.keys(doc.paths ?? {}).some((p) => p.startsWith("/rpc/")),
  };
}

/** The security an operation needs: its own, else the document's. An empty list means none; an empty requirement among several, optional. */
export const securityOf = (doc: OpenApi, op: Operation): SecurityRequirement[] => op.security ?? doc.security ?? [];

/** Every scope the operation's security asks for, for display. */
export function scopesOf(doc: OpenApi, op: Operation): string[] {
  const fromSecurity = securityOf(doc, op).flatMap((r) => Object.values(r).flat());
  return [...new Set(fromSecurity.length ? fromSecurity : (op["x-scopes"] ?? []))];
}

/** The server requests go to: the operation's, the path item's or the document's first, variables filled in, made absolute against `origin`. */
export function serverUrlOf(doc: OpenApi, entry: Pick<OpEntry, "op" | "pathItem"> | undefined, origin: string): string {
  const s = entry?.op.servers?.[0] ?? entry?.pathItem.servers?.[0] ?? doc.servers?.[0];
  if (!s) return origin || "https://api.example.com";
  const url = s.url.replace(/\{([^}]+)\}/g, (_, name: string) => (s as NonNullable<OpenApi["servers"]>[number]).variables?.[name]?.default ?? `{${name}}`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url.replace(/\/+$/, "");
  return `${origin || "https://api.example.com"}${url.startsWith("/") ? "" : "/"}${url}`.replace(/\/+$/, "");
}

/** The media type to show for a body or response: JSON first, then any `+json`, then the first. */
export function pickMedia(content: Record<string, MediaType> | undefined): [string, MediaType] | undefined {
  const entries = Object.entries(content ?? {});
  return entries.find(([t]) => /^application\/json\b/i.test(t)) ?? entries.find(([t]) => /\+json\b/i.test(t)) ?? entries[0];
}
