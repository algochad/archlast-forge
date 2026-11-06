// The OpenAPI 3.1 document of a project: its public functions (/rpc), its HTTP routes (/http, or the root) and its NestJS controllers, with
// request and response schemas made from the same validators the engine checks calls with, so the document can't drift from what the engine
// accepts. What validators can't say (the API's name, its real authentication, its errors, headers, webhooks, who the document is for)
// comes from `http.docs()` in forge/http.ts and from each route's own documentation (RouteDocs).
import type { ApiDocsConfig, DocError, RouteDocs, SecurityRequirement } from "../api-docs";
import type { FunctionKind, HttpRoute } from "../functions";
import type { PropertyValidators, Validator } from "../values";

export type JsonSchema = Record<string, unknown>;

/** A Nest route as nest.ts reads it from Nest's metadata: method, path below the origin, its @Contract, and what its guards declare (ApiSecurity). */
export interface NestRoute {
  method: string;
  path: string;
  name: string;
  contract?: { body?: Validator; query?: PropertyValidators; params?: PropertyValidators; returns?: Validator; summary?: string; description?: string; tags?: string[] } & RouteDocs;
}

export interface OpenApiInput {
  title: string;
  version: string;
  functions: { name: string; kind: FunctionKind; visibility: "public" | "internal"; args: Record<string, unknown>; returns?: unknown }[];
  http: HttpRoute[];
  /** The routes are served at the root (`httpRouter({ root: true })`), so they are described there instead of under /http. */
  httpRoot?: boolean;
  nest: NestRoute[];
  /** What `http.docs()` said. */
  docs?: ApiDocsConfig;
  /**
   * "public" (the default) is the document the docs are for: `include`, `exclude`, `functions: false` and hidden routes leave things out.
   * "all", for development, lists everything, with what the public document leaves out marked `x-internal`.
   */
  audience?: "public" | "all";
}

/** The schemas named with `name` in their validator's meta, collected while the document is built, so each is written once and referred to. */
class Named {
  readonly schemas = new Map<string, { schema: JsonSchema; key: string }>();
  ref(name: string, build: () => JsonSchema): JsonSchema {
    const schema = build();
    const key = JSON.stringify(schema);
    const known = this.schemas.get(name);
    if (known && known.key !== key) throw new Error(`Two different validators are named "${name}" for the API docs: give one of them another name`);
    if (!known) this.schemas.set(name, { schema, key });
    return { $ref: `#/components/schemas/${encodeURIComponent(name)}` };
  }
}

const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/;

/** A validator as JSON Schema (the 2020-12 dialect OpenAPI 3.1 uses). With `named`, a validator that has a name becomes a reference to it. */
export function toJsonSchema(v: Validator, named?: Named): JsonSchema {
  const name = v.meta?.name;
  if (name && named) {
    if (!COMPONENT_NAME.test(name)) throw new Error(`"${name}" can't name a schema in the API docs: use letters, digits, ".", "_" and "-"`);
    return named.ref(name, () => schemaOf(v, named));
  }
  return schemaOf(v, named);
}

function schemaOf(v: Validator, named?: Named): JsonSchema {
  const c = v.checks;
  let s: JsonSchema;
  switch (v.kind) {
    case "string":
      s = {
        type: "string",
        ...(c?.minLength !== undefined && { minLength: c.minLength }),
        ...(c?.maxLength !== undefined && { maxLength: c.maxLength }),
        ...(c?.pattern !== undefined && { pattern: c.pattern }),
        ...(c?.format && { format: c.format }),
      };
      break;
    case "number":
      s = {
        type: c?.int ? "integer" : "number",
        ...(c?.min !== undefined && { minimum: c.min }),
        ...(c?.max !== undefined && { maximum: c.max }),
        ...(c?.exclusiveMin !== undefined && { exclusiveMinimum: c.exclusiveMin }),
        ...(c?.exclusiveMax !== undefined && { exclusiveMaximum: c.exclusiveMax }),
      };
      break;
    case "boolean":
      s = { type: "boolean" };
      break;
    case "null":
      s = { type: "null" };
      break;
    case "literal":
      s = { type: typeof v.value === "number" ? (Number.isInteger(v.value) ? "integer" : "number") : typeof v.value, const: v.value };
      break;
    case "id":
      s = { type: "string", pattern: `^${v.table}:[0-9a-f]{32}$`, description: `The id of a document in "${v.table}"` };
      break;
    case "array":
      s = {
        type: "array",
        items: toJsonSchema(v.element!, named),
        ...(c?.minItems !== undefined && { minItems: c.minItems }),
        ...(c?.maxItems !== undefined && { maxItems: c.maxItems }),
        ...(c?.unique && { uniqueItems: true }),
      };
      break;
    case "object":
      s = fieldsSchema(v.fields ?? {}, named);
      break;
    case "union":
      s = unionSchema(v.members!, named);
      break;
    case "any":
      s = {};
      break;
  }
  const m = v.meta;
  if (!m) return s;
  return {
    ...s,
    ...(m.title && { title: m.title }),
    ...(m.description && { description: m.description }),
    ...(m.example !== undefined && { examples: [m.example] }),
    ...(m.default !== undefined && { default: m.default }),
    ...(m.deprecated && { deprecated: true }),
  };
}

/** Literals of one type are an enum; one other schema and null is that schema made nullable; anything else is anyOf. */
function unionSchema(members: Validator[], named?: Named): JsonSchema {
  const literals = members.filter((m) => m.kind === "literal");
  const nulls = members.filter((m) => m.kind === "null" && !m.meta);
  const rest = members.filter((m) => m.kind !== "literal" && !nulls.includes(m));
  const types = new Set(literals.map((m) => typeof m.value));
  if (literals.length && !rest.length && types.size === 1) {
    const type = [...types][0] === "number" ? (literals.every((m) => Number.isInteger(m.value)) ? "integer" : "number") : [...types][0]!;
    return { type: nulls.length ? [type, "null"] : type, enum: [...literals.map((m) => m.value), ...(nulls.length ? [null] : [])] };
  }
  if (rest.length === 1 && !literals.length && nulls.length) {
    const inner = toJsonSchema(rest[0]!, named);
    // A plain typed schema takes "null" into its type; a reference or a combination can't, so it is one of the two.
    if (typeof inner.type === "string" && !inner.$ref) return { ...inner, type: [inner.type, "null"], ...(inner.enum ? { enum: [...(inner.enum as unknown[]), null] } : {}) };
    return { anyOf: [inner, { type: "null" }] };
  }
  return { anyOf: members.map((m) => toJsonSchema(m, named)) };
}

function fieldsSchema(fields: Record<string, unknown>, named?: Named): JsonSchema {
  const entries = Object.entries(fields) as [string, Validator][];
  const required = entries.filter(([, f]) => !f.optional).map(([k]) => k);
  return { type: "object", properties: Object.fromEntries(entries.map(([k, f]) => [k, toJsonSchema(f, named)])), ...(required.length && { required }), additionalProperties: false };
}

/** A sample value for a schema's validator: its example, its default, or one made from its type, for the request and response examples. */
export function exampleOf(v: Validator, depth = 0): unknown {
  if (v.meta?.example !== undefined) return v.meta.example;
  if (v.meta?.default !== undefined) return v.meta.default;
  if (depth > 6) return null;
  const c = v.checks;
  switch (v.kind) {
    case "string":
      return c?.format === "email" ? "ada@example.com" : c?.format === "uri" ? "https://example.com" : c?.format === "uuid" ? "3fa85f64-5717-4562-b3fc-2c963f66afa6" : c?.format === "date-time" ? "2026-01-31T12:00:00Z" : c?.format === "date" ? "2026-01-31" : "string";
    case "number":
      return c?.min ?? (c?.exclusiveMin !== undefined ? c.exclusiveMin + 1 : c?.int ? 1 : 1.5);
    case "boolean":
      return true;
    case "null":
      return null;
    case "literal":
      return v.value;
    case "id":
      return `${v.table}:${"0".repeat(32)}`;
    case "array":
      return [exampleOf(v.element!, depth + 1)];
    case "object":
      return Object.fromEntries(Object.entries(v.fields ?? {}).map(([k, f]) => [k, exampleOf(f, depth + 1)]));
    case "union":
      return exampleOf(v.members!.find((m) => m.kind !== "null") ?? v.members![0]!, depth + 1);
    case "any":
      return {};
  }
}

const ERROR_CODES: [status: string, code: string, when: string][] = [
  ["400", "BAD_REQUEST", "The arguments don't match the validators, or the function threw a ForgeError"],
  ["401", "UNAUTHORIZED", "The function needs a signed-in caller"],
  ["408", "TIMEOUT", "The function ran past its time limit"],
  ["429", "TOO_MANY_REQUESTS", "Rate limited: wait for Retry-After"],
  ["500", "INTERNAL_SERVER_ERROR", "The function failed (the message is generic outside dev; the request id finds it in the logs)"],
];

const engineErrors = (codes: string[]) =>
  Object.fromEntries(ERROR_CODES.filter(([s]) => codes.includes(s)).map(([status, , when]) => [status, { description: when, content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } } }]));

/** What each HTTP status is called, for an error response with no description of its own. */
const STATUS_TEXT: Record<string, string> = {
  "400": "Bad request",
  "401": "Not authenticated",
  "402": "Payment required",
  "403": "Not allowed",
  "404": "Not found",
  "405": "Method not allowed",
  "409": "Conflict",
  "410": "Gone",
  "412": "Precondition failed",
  "413": "Too large",
  "415": "Unsupported media type",
  "422": "Can't be processed",
  "429": "Too many requests",
  "500": "Server error",
  "501": "Not implemented",
  "502": "Bad gateway",
  "503": "Unavailable",
  "504": "Gateway timeout",
};

/** `/users/:id` (Nest, path-to-regexp) as `/users/{id}`, and the parameters it names. */
function templated(path: string) {
  const names: string[] = [];
  const out = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?\??/g, (_, name: string) => (names.push(name), `{${name}}`)).replace(/\*/g, "");
  return { path: out.replace(/\/{2,}/g, "/") || "/", names };
}

/** The document. `servers` is left to whoever serves it, who knows the address it was asked at, unless the app names them. */
export function buildOpenApi(input: OpenApiInput) {
  const docs = input.docs ?? {};
  const all = input.audience === "all";
  const named = new Named();
  const json = (v: Validator) => toJsonSchema(v, named);
  const paths: Record<string, Record<string, unknown>> = {};
  const usesEngineAuth = { value: false };
  const usesErrorBody = { value: false };

  const underAny = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));
  /** Whether the public document leaves this path out, and so the complete one marks it internal. */
  const leftOut = (path: string, hidden?: boolean) =>
    Boolean(hidden) || (docs.include?.length ? !underAny(path, docs.include) : false) || underAny(path, docs.exclude ?? []);
  // An operation id written in the code is kept. A route without one but with a summary gets it from the summary ("Create a product" is
  // createAProduct), unique in the document: it ends the docs page's address and names the method in generated clients, where the
  // controller and method (`CheckoutsController_create`) would be an implementation detail.
  const taken = new Set([...input.http.map((r) => r.operationId), ...input.nest.map((n) => n.contract?.operationId)].filter((id): id is string => !!id));
  const idOf = (given: string | undefined, summary: string | undefined, fallback: string) => {
    if (given) return given;
    const words = (summary ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return fallback;
    const base = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("").replace(/^(?=\d)/, "op");
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
    taken.add(id);
    return id;
  };

  const add = (path: string, method: string, op: Record<string, unknown>, hidden?: boolean) => {
    const internal = leftOut(path, hidden);
    if (internal && !all) return;
    (paths[path] ??= {})[method.toLowerCase()] = internal ? { ...op, "x-internal": true } : op;
  };

  // ---- what every documented route shares: the app's errors, parameters and headers ----
  const errorContentType = docs.errors?.contentType ?? "application/json";
  const errorSchema = docs.errors ? json(docs.errors.schema) : undefined;
  const parameterRef = (key: string) => ({ $ref: `#/components/parameters/${encodeURIComponent(key)}` });
  const globalParameters = Object.entries(docs.parameters ?? {}).filter(([, p]) => p.global).map(([key]) => parameterRef(key));
  const commonHeaders = Object.fromEntries(Object.entries(docs.headers ?? {}).map(([name, h]) => [name, { ...(h.description && { description: h.description }), schema: h.schema ? json(h.schema) : { type: "string" } }]));

  const errorList = (errors: Record<string, DocError | DocError[]> | undefined) =>
    Object.entries(errors ?? {}).flatMap(([status, e]) => [e].flat().map((x) => ({ status: String(status), ...(typeof x === "string" ? { code: x } : x) })));

  /** The responses and extensions a route's documentation adds: its error statuses (with the app's error schema) and their codes. */
  function errorResponses(route: RouteDocs, validationStatus: boolean, engineBody: boolean) {
    const codes = [...errorList(docs.errors?.common), ...errorList(route.errors)];
    const statuses = [...new Set([...(validationStatus ? ["400"] : []), ...codes.map((c) => c.status)])].sort();
    const responses: Record<string, unknown> = {};
    for (const status of statuses) {
      const mine = codes.filter((c) => c.status === status);
      const validation = status === "400" && validationStatus;
      // An http.route()'s validation answer is the engine's own error body. Anything else is the app's: its error schema when it has said
      // what that is, and otherwise no schema (a Nest route answers in Nest's shape, or the app's exception filter's).
      const content = validation && engineBody && !mine.length ? ERROR_BODY_CONTENT : errorSchema ? { [errorContentType]: { schema: errorSchema } } : engineBody ? ERROR_BODY_CONTENT : undefined;
      if (content === ERROR_BODY_CONTENT) usesErrorBody.value = true;
      const describe = mine.map((c) => (c.description ? `\`${c.code}\`: ${c.description}` : `\`${c.code}\``)).join("; ");
      responses[status] = {
        description: [validation ? "The request doesn't match the route's validators" : "", describe].filter(Boolean).join(". ") || STATUS_TEXT[status] || `Status ${status}`,
        ...(content && { content }),
      };
    }
    return { responses, ...(codes.length && { "x-error-codes": codes.map(({ status, code, description }) => ({ status, code, ...(description && { description }) })) }) };
  }

  /** Parameters, security, examples and the rest a route's documentation adds to its operation. */
  function routeExtras(r: RouteDocs) {
    const security = r.security ?? docs.security;
    const scopes = [...new Set((security ?? []).flatMap((req) => Object.values(req).flat()))];
    return {
      parameters: [
        ...globalParameters,
        ...(r.parameters ?? []).filter((k) => !docs.parameters?.[k]?.global).map(parameterRef),
        ...Object.entries(r.headers ?? {}).map(([name, h]) => ({
          name,
          in: "header",
          required: h.required === true,
          schema: h.schema ? json(h.schema) : { type: "string" },
          ...(h.description && { description: h.description }),
          ...(h.example !== undefined && { example: h.example }),
        })),
      ],
      extra: {
        ...(r.deprecated && { deprecated: true }),
        ...(r.security && { security: r.security }),
        ...(scopes.length && { "x-scopes": scopes }),
        ...(r.codeSamples?.length && { "x-codeSamples": r.codeSamples }),
      },
    };
  }

  function successResponse(r: RouteDocs, returns: Validator | undefined, fallback: string) {
    const headers = { ...commonHeaders, ...Object.fromEntries(Object.entries(r.responseHeaders ?? {}).map(([name, h]) => [name, { ...(h.description && { description: h.description }), schema: h.schema ? json(h.schema) : { type: "string" } }])) };
    return {
      description: r.responseDescription ?? fallback,
      ...(Object.keys(headers).length && { headers }),
      ...(returns && { content: { "application/json": { schema: json(returns), example: exampleOf(returns) } } }),
    };
  }

  const body = (v: Validator) => ({ required: !v.optional, content: { "application/json": { schema: json(v), example: exampleOf(v) } } });
  const queryParameters = (query: PropertyValidators | undefined) =>
    Object.entries(query ?? {}).map(([name, v]) => ({
      name,
      in: "query",
      required: !v.optional,
      schema: json(v),
      ...(v.meta?.description && { description: v.meta.description }),
      ...(v.meta?.deprecated && { deprecated: true }),
    }));

  // ---- the reactive functions ----
  if (docs.functions !== false || all)
    for (const f of input.functions) {
      if (f.visibility !== "public") continue; // internal functions never reach a client, so they aren't described either
      const module = f.name.split(":")[0]!;
      usesEngineAuth.value = usesErrorBody.value = true;
      const op = {
        operationId: f.name.replace(/[^A-Za-z0-9_]/g, "_"),
        tags: [module],
        summary: `${f.kind} ${f.name}`,
        description: `Calls the ${f.kind} \`${f.name}\`.${f.kind === "query" ? " A query also answers `GET /rpc/" + f.name + "?args=<JSON>`, and the WebSocket at /rpc keeps it live." : ""}`,
        requestBody: { required: true, content: { "application/json": { schema: fieldsSchema(f.args, named) } } },
        responses: {
          "200": {
            description: "The function's result",
            content: { "application/json": { schema: { type: "object", properties: { result: f.returns ? json(f.returns as Validator) : {} }, required: ["result"] } } },
          },
          ...engineErrors(["400", "401", "408", "429", "500"]),
        },
        // Calls may be anonymous or signed in; each function decides what a caller may do.
        security: [{}, { session: [] }, { bearer: [] }],
      };
      // With functions: false they appear only in the complete document.
      const path = `/rpc/${f.name}`;
      if (docs.functions === false) (paths[path] ??= {}).post = { ...op, "x-internal": true };
      else add(path, "post", op);
    }

  // ---- forge/http.ts ----
  for (const r of input.http) {
    if ((r.handler as unknown as Record<symbol, unknown>)[NEST_MOUNT]) continue; // Nest's mount point: its controllers are listed one by one below
    const exact = r.path !== undefined;
    const base = input.httpRoot ? "" : "/http";
    const path = exact ? `${base}${r.path}` : `${base}${r.pathPrefix}{rest}`;
    const name = `http ${r.method} ${r.path ?? `${r.pathPrefix}*`}`;
    const { parameters, extra } = routeExtras(r);
    const errors = errorResponses(r, Boolean(r.query || r.body), true);
    add(
      path,
      r.method,
      {
        operationId: idOf(r.operationId, r.summary, `http_${r.method}_${(r.path ?? r.pathPrefix!).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`),
        tags: r.tags ?? ["HTTP routes"],
        summary: r.summary ?? name,
        ...(r.description && { description: r.description }),
        parameters: [...(exact ? [] : [{ name: "rest", in: "path", required: true, schema: { type: "string" }, description: `Anything below ${r.pathPrefix}` }]), ...queryParameters(r.query), ...parameters],
        ...(r.body && { requestBody: body(r.body) }),
        responses: { [String(r.status ?? 200)]: successResponse(r, r.returns, "The route's answer"), ...errors.responses },
        ...(errors["x-error-codes"] && { "x-error-codes": errors["x-error-codes"] }),
        ...extra,
      },
      r.hidden,
    );
  }

  // ---- Nest controllers ----
  for (const n of input.nest) {
    const { path, names } = templated(n.path);
    const c = n.contract ?? {};
    const { parameters, extra } = routeExtras(c);
    const errors = errorResponses(c, Boolean(c.body || c.query || c.params), false);
    add(
      path,
      n.method,
      {
        operationId: idOf(c.operationId, c.summary, n.name.replace(/[^A-Za-z0-9_]/g, "_")),
        tags: c.tags ?? [n.name.split(".")[0]!],
        summary: c.summary ?? `${n.method} ${n.path}`,
        ...(c.description && { description: c.description }),
        parameters: [
          ...names.map((name) => {
            const p = c.params?.[name];
            return { name, in: "path", required: true, schema: p ? json(p) : { type: "string" }, ...(p?.meta?.description && { description: p.meta.description }) };
          }),
          ...queryParameters(c.query),
          ...parameters,
        ],
        ...(c.body && { requestBody: body(c.body) }),
        responses: { [String(c.status ?? (n.method === "POST" ? 201 : 200))]: successResponse(c, c.returns, "The handler's answer"), ...errors.responses },
        ...(errors["x-error-codes"] && { "x-error-codes": errors["x-error-codes"] }),
        ...extra,
      },
      c.hidden,
    );
  }

  // ---- the events the app sends ----
  const webhooks: Record<string, unknown> = {};
  if (docs.webhooks)
    for (const [type, e] of Object.entries(docs.webhooks.events)) {
      const data = e.data ? json(e.data) : {};
      const example = { type, timestamp: "2026-01-31T12:00:00.000Z", data: e.example ?? (e.data ? exampleOf(e.data) : {}) };
      webhooks[type] = {
        post: {
          operationId: `webhook_${type.replace(/[^A-Za-z0-9_]+/g, "_")}`,
          summary: e.summary ?? type,
          ...(e.description && { description: e.description }),
          parameters: [
            { name: "webhook-id", in: "header", required: true, schema: { type: "string" }, description: "The message's id: the same on every retry, so a receiver can skip one it has already handled." },
            { name: "webhook-timestamp", in: "header", required: true, schema: { type: "string" }, description: "When it was signed, in seconds since 1970." },
            { name: "webhook-signature", in: "header", required: true, schema: { type: "string" }, description: '`v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, one per signing secret, separated by spaces.' },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { type: { type: "string", const: type }, timestamp: { type: "string", format: "date-time" }, data },
                  required: ["type", "timestamp", "data"],
                },
                example,
              },
            },
          },
          responses: { "2XX": { description: "Any 2xx status acknowledges the event. Other statuses, and no answer in time, are retried." } },
        },
      };
    }

  // ---- components and the document ----
  const schemes: Record<string, unknown> = { ...docs.securitySchemes };
  if (usesEngineAuth.value) {
    schemes.session ??= { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "The session cookie Better Auth sets at sign-in (/api/auth)" };
    schemes.bearer ??= { type: "http", scheme: "bearer", description: "A session token, with Better Auth's bearer() plugin" };
  }
  const parametersComponent = Object.fromEntries(
    Object.entries(docs.parameters ?? {}).map(([key, p]) => [
      key,
      {
        name: p.name,
        in: p.in,
        required: p.in === "path" ? true : p.required === true,
        schema: p.schema ? json(p.schema) : { type: "string" },
        ...(p.description && { description: p.description }),
        ...(p.example !== undefined && { example: p.example }),
        ...(p.deprecated && { deprecated: true }),
      },
    ]),
  );
  const servers = docs.servers?.map((s) => (typeof s === "string" ? { url: s } : s));
  const r = docs.webhooks?.retry;
  const doc = {
    openapi: "3.1.0",
    info: {
      title: docs.info?.title ?? input.title,
      version: docs.info?.version ?? input.version,
      ...(docs.info?.description && { description: docs.info.description }),
      ...(docs.info?.termsOfService && { termsOfService: docs.info.termsOfService }),
      ...(docs.info?.contact && { contact: docs.info.contact }),
      ...(docs.info?.license && { license: docs.info.license }),
    },
    ...(servers?.length && { servers }),
    ...(docs.tags?.length && { tags: docs.tags.map((t) => ({ name: t.name, ...(t.description && { description: t.description }) })) }),
    ...(docs.tagGroups?.length && { "x-tagGroups": docs.tagGroups }),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : 1))),
    ...(Object.keys(webhooks).length && {
      webhooks,
      "x-webhooks-signing": {
        scheme: "standard",
        envelope: { type: "The event type", timestamp: "When the event happened (ISO 8601)", data: "The event's object" },
        retry: { attempts: r?.attempts ?? 10, delayMs: r?.delayMs ?? 5_000, factor: r?.factor ?? 4, maxDelayMs: r?.maxDelayMs ?? 86_400_000, timeoutMs: docs.webhooks!.timeoutMs ?? 15_000 },
        toleranceMs: docs.webhooks!.toleranceMs ?? 300_000,
      },
    }),
    components: {
      schemas: {
        ...(usesErrorBody.value && { ErrorBody: ERROR_BODY }),
        ...Object.fromEntries([...named.schemas].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, { schema }]) => [name, schema])),
      },
      ...(Object.keys(parametersComponent).length && { parameters: parametersComponent }),
      ...(Object.keys(schemes).length && { securitySchemes: schemes }),
    },
    ...(docs.security ? { security: docs.security } : usesEngineAuth.value && !docs.securitySchemes ? { security: [{}, { session: [] }, { bearer: [] }] as SecurityRequirement[] } : {}),
  };
  return doc;
}

const ERROR_BODY_CONTENT = { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } };

const ERROR_BODY: JsonSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { message: { type: "string" }, code: { type: "string", enum: ERROR_CODES.map(([, c]) => c).concat(["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE"]) }, data: {}, requestId: { type: "string" } },
      required: ["message", "code", "requestId"],
    },
  },
  required: ["error"],
};

/** Marks the HTTP route nest() mounts, so the document lists Nest's controllers instead of one catch-all. */
export const NEST_MOUNT = Symbol.for("archlast-forge.nest-mount");

/** In development: routes the public document lists without what a reader needs, as warnings to print once. */
export function docsWarnings(doc: ReturnType<typeof buildOpenApi>): string[] {
  const out: string[] = [];
  for (const [path, methods] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
      if (op["x-internal"] || path.startsWith("/rpc/")) continue;
      const missing = [
        !Object.entries(op.responses as Record<string, { content?: unknown }>).some(([s, r]) => s.startsWith("2") && r.content) && "returns",
        String(op.summary ?? "").startsWith(method.toUpperCase()) || String(op.summary ?? "").startsWith("http ") ? "summary" : false,
        (op.tags as string[] | undefined)?.[0] === "HTTP routes" && "tags",
      ].filter(Boolean);
      if (missing.length) out.push(`${method.toUpperCase()} ${path}: no ${missing.join(", ")}`);
    }
  return out;
}
