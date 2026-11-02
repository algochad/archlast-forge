// The OpenAPI 3.1 document of a project: its public functions (/rpc), its HTTP routes (/http) and its NestJS controllers, with request and
// response schemas made from the same validators the engine checks calls with, so the document can't drift from what the engine accepts.
import type { FunctionKind, HttpRoute } from "../functions";
import type { PropertyValidators, Validator } from "../values";

export type JsonSchema = Record<string, unknown>;

/** A Nest route as nest.ts reads it from Nest's metadata: method, path below the origin, and its @Contract, when it has one. */
export interface NestRoute {
  method: string;
  path: string;
  name: string;
  contract?: { body?: Validator; query?: PropertyValidators; params?: PropertyValidators; returns?: Validator; summary?: string; description?: string; tags?: string[] };
}

export interface OpenApiInput {
  title: string;
  version: string;
  functions: { name: string; kind: FunctionKind; visibility: "public" | "internal"; args: Record<string, unknown>; returns?: unknown }[];
  http: HttpRoute[];
  nest: NestRoute[];
}

/** A validator as JSON Schema (the 2020-12 dialect OpenAPI 3.1 uses). */
export function toJsonSchema(v: Validator): JsonSchema {
  switch (v.kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "id":
      return { type: "string", pattern: `^${v.table}:[0-9a-f]{32}$`, description: `The id of a document in "${v.table}"` };
    case "array":
      return { type: "array", items: toJsonSchema(v.element!) };
    case "object":
      return fieldsSchema(v.fields ?? {});
    case "union":
      return { anyOf: v.members!.map(toJsonSchema) };
  }
}

function fieldsSchema(fields: Record<string, unknown>): JsonSchema {
  const entries = Object.entries(fields) as [string, Validator][];
  const required = entries.filter(([, f]) => !f.optional).map(([k]) => k);
  return { type: "object", properties: Object.fromEntries(entries.map(([k, f]) => [k, toJsonSchema(f)])), ...(required.length && { required }), additionalProperties: false };
}

const ERROR_CODES: [status: string, code: string, when: string][] = [
  ["400", "BAD_REQUEST", "The arguments don't match the validators, or the function threw a ForgeError"],
  ["401", "UNAUTHORIZED", "The function needs a signed-in caller"],
  ["408", "TIMEOUT", "The function ran past its time limit"],
  ["429", "TOO_MANY_REQUESTS", "Rate limited: wait for Retry-After"],
  ["500", "INTERNAL_SERVER_ERROR", "The function failed (the message is generic outside dev; the request id finds it in the logs)"],
];

const errorResponses = (codes: string[]) =>
  Object.fromEntries(ERROR_CODES.filter(([s]) => codes.includes(s)).map(([status, , when]) => [status, { description: when, content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } }]));

/** `/users/:id` (Nest, path-to-regexp) as `/users/{id}`, and the parameters it names. */
function templated(path: string) {
  const names: string[] = [];
  const out = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?\??/g, (_, name: string) => (names.push(name), `{${name}}`)).replace(/\*/g, "");
  return { path: out.replace(/\/{2,}/g, "/") || "/", names };
}

const queryParameters = (query: PropertyValidators | undefined) =>
  Object.entries(query ?? {}).map(([name, v]) => ({ name, in: "query", required: !v.optional, schema: toJsonSchema(v) }));

/** The document. `servers` is left to whoever serves it, who knows the address it was asked at. */
export function buildOpenApi(input: OpenApiInput) {
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (path: string, method: string, op: object) => ((paths[path] ??= {})[method.toLowerCase()] = op);

  for (const f of input.functions) {
    if (f.visibility !== "public") continue; // internal functions never reach a client, so they aren't described either
    const module = f.name.split(":")[0]!;
    add(`/rpc/${f.name}`, "post", {
      operationId: f.name.replace(/[^A-Za-z0-9_]/g, "_"),
      tags: [module],
      summary: `${f.kind} ${f.name}`,
      description: `Calls the ${f.kind} \`${f.name}\`.${f.kind === "query" ? " A query also answers `GET /rpc/" + f.name + "?args=<JSON>`, and the WebSocket at /rpc keeps it live." : ""}`,
      requestBody: { required: true, content: { "application/json": { schema: fieldsSchema(f.args) } } },
      responses: {
        "200": {
          description: "The function's result",
          content: { "application/json": { schema: { type: "object", properties: { result: f.returns ? toJsonSchema(f.returns as Validator) : {} }, required: ["result"] } } },
        },
        ...errorResponses(["400", "401", "408", "429", "500"]),
      },
    });
  }

  for (const r of input.http) {
    if ((r.handler as unknown as Record<symbol, unknown>)[NEST_MOUNT]) continue; // Nest's mount point: its controllers are listed one by one below
    const exact = r.path !== undefined;
    const path = exact ? `/http${r.path}` : `/http${r.pathPrefix}{rest}`;
    const name = `http ${r.method} ${r.path ?? `${r.pathPrefix}*`}`;
    add(path, r.method, {
      operationId: `http_${r.method}_${(r.path ?? r.pathPrefix!).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`,
      tags: r.tags ?? ["HTTP routes"],
      summary: r.summary ?? name,
      ...(r.description && { description: r.description }),
      parameters: [...(exact ? [] : [{ name: "rest", in: "path", required: true, schema: { type: "string" }, description: `Anything below ${r.pathPrefix}` }]), ...queryParameters(r.query)],
      ...(r.body && { requestBody: { required: !r.body.optional, content: { "application/json": { schema: toJsonSchema(r.body) } } } }),
      responses: {
        "200": r.returns ? { description: "The route's answer", content: { "application/json": { schema: toJsonSchema(r.returns) } } } : { description: "The route's answer" },
        ...(r.query || r.body ? { "400": { description: "The query or body doesn't match the route's validators", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } } } : {}),
      },
    });
  }

  for (const n of input.nest) {
    const { path, names } = templated(n.path);
    const c = n.contract;
    add(path, n.method, {
      operationId: n.name.replace(/[^A-Za-z0-9_]/g, "_"),
      tags: c?.tags ?? [n.name.split(".")[0]!],
      summary: c?.summary ?? `${n.method} ${n.path}`,
      ...(c?.description && { description: c.description }),
      parameters: [
        ...names.map((name) => ({ name, in: "path", required: true, schema: c?.params?.[name] ? toJsonSchema(c.params[name]!) : { type: "string" } })),
        ...queryParameters(c?.query),
      ],
      ...(c?.body && { requestBody: { required: !c.body.optional, content: { "application/json": { schema: toJsonSchema(c.body) } } } }),
      responses: {
        [n.method === "POST" ? "201" : "200"]: c?.returns ? { description: "The handler's answer", content: { "application/json": { schema: toJsonSchema(c.returns) } } } : { description: "The handler's answer" },
        ...(c?.body || c?.query || c?.params ? { "400": { description: "The request doesn't match the route's contract" } } : {}),
      },
    });
  }

  const doc = {
    openapi: "3.1.0",
    info: { title: input.title, version: input.version },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : 1))),
    components: {
      schemas: {
        ErrorBody: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { message: { type: "string" }, code: { type: "string", enum: ERROR_CODES.map(([, c]) => c).concat(["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE"]) }, data: {}, requestId: { type: "string" } },
              required: ["message", "code", "requestId"],
            },
          },
          required: ["error"],
        } as JsonSchema,
      },
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "The session cookie Better Auth sets at sign-in (/api/auth)" },
        bearer: { type: "http", scheme: "bearer", description: "A session token, with Better Auth's bearer() plugin" },
      },
    },
    // Calls may be anonymous or signed in; each function decides what a caller may do.
    security: [{}, { session: [] }, { bearer: [] }],
  };
  return shareSchemas(doc);
}

/** Marks the HTTP route nest() mounts, so the document lists Nest's controllers instead of one catch-all. */
export const NEST_MOUNT = Symbol.for("archlast-forge.nest-mount");

/**
 * Object schemas that appear more than once move to `components.schemas` and are referenced from where they were. Only schemas something
 * uses end up there, so there is nothing unused to remove.
 */
function shareSchemas<D extends { paths: object; components: { schemas: Record<string, JsonSchema> } }>(doc: D): D {
  const seen = new Map<string, { count: number; schema: JsonSchema }>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const s = node as JsonSchema;
    if (s.type === "object" && s.properties && Object.keys(s.properties as object).length >= 2) {
      const key = JSON.stringify(s);
      const e = seen.get(key) ?? { count: 0, schema: s };
      e.count++;
      seen.set(key, e);
    }
    for (const value of Object.values(s)) visit(value);
  };
  visit(doc.paths);
  const names = new Map<string, string>();
  let n = 0;
  for (const [key, e] of seen) if (e.count > 1) names.set(key, `Shared${++n}`);
  if (!names.size) return doc;
  const replace = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(replace);
    const name = names.get(JSON.stringify(node));
    if (name) return { $ref: `#/components/schemas/${name}` };
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, replace(v)]));
  };
  const schemas = Object.fromEntries([...names].map(([key, name]) => [name, JSON.parse(key) as JsonSchema]));
  return { ...doc, paths: replace(doc.paths) as object, components: { ...doc.components, schemas: { ...doc.components.schemas, ...schemas } } };
}
