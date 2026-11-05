export type Kind = "query" | "mutation" | "action";
export type Role = "owner" | "admin" | "viewer";
export type Validator = {
  kind: string;
  optional: boolean;
  table?: string;
  element?: Validator;
  fields?: Record<string, Validator>;
  members?: Validator[];
  /** A literal's value. */
  value?: string | number | boolean;
  meta?: { description?: string; example?: unknown; default?: unknown; deprecated?: boolean; name?: string; title?: string };
  checks?: { min?: number; max?: number; int?: boolean; minLength?: number; maxLength?: number; pattern?: string; format?: string; minItems?: number; maxItems?: number };
};
/** The values of a union of literals (an enum), or null when it is something else. */
export const enumValues = (v: Validator) => (v.kind === "union" && v.members!.every((m) => m.kind === "literal") ? v.members!.map((m) => m.value!) : null);
export type FunctionInfo = { name: string; kind: Kind; visibility: "public" | "internal"; args: Record<string, Validator>; returns?: Validator };
export type TableInfo = {
  fields: Record<string, Validator>;
  indexes: Record<string, string[]>;
  searchIndexes?: Record<string, { searchField: string; filterFields: string[] }>;
  strict: boolean;
};
export type Manifest = {
  functions: FunctionInfo[];
  tables: Record<string, TableInfo>;
  crons: { name: string; fn: string; schedule: { kind: string; ms?: number; expression?: string } }[];
  storage: boolean;
  release?: string;
  error?: string;
};
export type CacheInfo = {
  enabled: boolean;
  backend: "memory" | "redis";
  ttlMs: number;
  /** In-process cache budget; null when Redis holds the entries. */
  maxBytes: number | null;
  entries: number | null;
  bytes: number | null;
  evictions: number;
  invalidatedEntries: number;
  hits: number;
  misses: number;
  coalesced: number;
  skipped: number;
  functions: { name: string; hits: number; misses: number; coalesced: number; skipped: number; hitMs: number; missMs: number; perUser: boolean; savedMs: number }[];
};
export type Admin = { email: string; role: Role };
export type Doc = Record<string, unknown> & { _id: string; _creationTime: number };
export type Page<T = Doc> = { page: T[]; isDone: boolean; continueCursor: string };
export type Log = { time: number; name: string; level: string; message: string; durationMs?: number; ok?: boolean | number; requestId?: string; server?: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const HEADERS = { "content-type": "application/json", "x-forge-admin": "1" };

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error?.message ?? body?.message ?? res.statusText, res.status);
  return body as T;
}

// The backend the pages show: this app, or one of its microservices (MICROSERVICES) by name, whose admin API this app forwards to.
// Telemetry is this app's for all of them, so obs.* calls never go elsewhere.
const BACKEND_KEY = "afx:backend";
let target = (() => {
  try {
    return localStorage.getItem(BACKEND_KEY) ?? "";
  } catch {
    return "";
  }
})();
let self = "";
/** The microservice picked, or "" for this app. */
export const backend = () => target;
/** The picked backend's name in telemetry: the microservice's, or this app's own (OTEL_SERVICE_NAME). */
export const backendService = () => target || self;
export const setSelf = (name: string) => void (self = name);
export function setBackend(name: string) {
  target = name;
  try {
    if (name) localStorage.setItem(BACKEND_KEY, name);
    else localStorage.removeItem(BACKEND_KEY);
  } catch {}
  window.dispatchEvent(new Event(BACKEND_KEY));
}
export const onBackend = (fn: () => void) => (window.addEventListener(BACKEND_KEY, fn), () => window.removeEventListener(BACKEND_KEY, fn));

/** An admin URL on the picked backend; `here` keeps it on this app. Who is signed in and the telemetry are always this app's. */
export function adminUrl(op: string, params: Record<string, string> = {}, here = false) {
  const q = new URLSearchParams(params);
  if (target && !here && !op.startsWith("obs.") && op !== "me" && op !== "microservices") q.set("target", target);
  const s = q.toString();
  return `/_admin/${op}${s ? `?${s}` : ""}`;
}

/** Read operations. The session cookie authenticates. */
export const get = <T>(op: string, input: object = {}, here = false) => fetch(adminUrl(op, { input: JSON.stringify(input) }, here), { credentials: "same-origin" }).then(unwrap<T>);

/** Write operations. */
export const post = <T>(op: string, input: object = {}) =>
  fetch(adminUrl(op), { method: "POST", credentials: "same-origin", headers: HEADERS, body: JSON.stringify(input) }).then(unwrap<T>);

export type Fleet = { self: string; services: { name: string; url: string }[] };

export const login = (body: { email: string; password: string } | { key: string }) =>
  fetch("/_admin/login", { method: "POST", credentials: "same-origin", headers: HEADERS, body: JSON.stringify(body) }).then(unwrap<Admin>);

export const logout = () => fetch("/_admin/logout", { method: "POST", credentials: "same-origin", headers: HEADERS });

export const canWrite = (a: Admin | null) => a?.role === "admin" || a?.role === "owner";

export const typeOf = (v: Validator): string =>
  v.kind === "id"
    ? `Id<"${v.table}">`
    : v.kind === "array"
      ? `${typeOf(v.element!)}[]`
      : v.kind === "object"
        ? `{ ${fieldsOf(v.fields!)} }`
        : v.kind === "union"
          ? v.members!.map(typeOf).join(" | ")
          : v.kind === "literal"
            ? JSON.stringify(v.value)
            : v.kind === "number" && v.checks?.int
              ? "integer"
              : v.kind;

export const fieldsOf = (fields: Record<string, Validator>) =>
  Object.entries(fields)
    .map(([k, v]) => `${k}${v.optional ? "?" : ""}: ${typeOf(v)}`)
    .join("; ");

export const formatBytes = (n: number | null | undefined) =>
  n == null ? "—" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

export const formatTime = (t: number) => new Date(t).toLocaleString();
export const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

/** Share of query calls answered without running the function: from the cache, or by sharing a run already in flight. */
export const hitRate = (c: { hits: number; misses: number; coalesced: number }) => {
  const served = c.hits + c.coalesced;
  return served + c.misses ? (served / (served + c.misses)) * 100 : null;
};

export const formatDuration = (ms: number) =>
  ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3600_000).toFixed(1)} h`;
