// A request for an operation in the shape code samples are made from, and the cURL sample. The other languages are in languages.ts, loaded
// when someone picks one. Credentials are always placeholders: a sample is something to copy, and what the visitor entered stays on the page.
import type { CodeSampleLanguage } from "./contract";
import { deref, parametersOf, pickMedia, securityOf, serverUrlOf, type OpEntry, type OpenApi } from "./openapi";
import { exampleOf, mediaExample } from "./schema";

export interface SampleRequest {
  method: string;
  url: string;
  headers: [string, string][];
  /** The body: JSON (as a value), form fields, or raw text. */
  body?: { kind: "json"; value: unknown; text: string } | { kind: "form"; fields: [string, string][]; text: string } | { kind: "raw"; text: string };
}

export const LANGUAGE_LABELS: Record<CodeSampleLanguage, string> = { curl: "cURL", node: "Node.js", python: "Python", go: "Go", php: "PHP", ruby: "Ruby", java: "Java", csharp: "C#" };

/** What stands where the visitor's secret would go. */
export const PLACEHOLDERS = { token: "YOUR_ACCESS_TOKEN", key: "YOUR_API_KEY", user: "YOUR_USERNAME", password: "YOUR_PASSWORD", cookie: "YOUR_SESSION" };

/** The first security alternative that names a scheme the document declares, as a header, a query field or Basic credentials. */
function authOf(doc: OpenApi, entry: OpEntry): { header?: [string, string]; query?: [string, string] } {
  const schemes = doc.components?.securitySchemes ?? {};
  for (const requirement of securityOf(doc, entry.op)) {
    for (const name of Object.keys(requirement)) {
      const s = deref(doc, schemes[name]);
      if (!s) continue;
      if (s.type === "http" && s.scheme?.toLowerCase() === "basic") return { header: ["Authorization", `Basic ${PLACEHOLDERS.user}:${PLACEHOLDERS.password}`] };
      if (s.type === "http" || s.type === "oauth2" || s.type === "openIdConnect") return { header: ["Authorization", `Bearer ${PLACEHOLDERS.token}`] };
      if (s.type === "apiKey" && s.name) {
        if (s.in === "query") return { query: [s.name, PLACEHOLDERS.key] };
        return { header: s.in === "cookie" ? ["Cookie", `${s.name}=${PLACEHOLDERS.cookie}`] : [s.name, PLACEHOLDERS.key] };
      }
    }
  }
  return {};
}

const paramExample = (doc: OpenApi, p: { example?: unknown; examples?: Record<string, { value?: unknown }>; schema?: Parameters<typeof exampleOf>[1] }) => {
  if (p.example !== undefined) return p.example;
  const first = Object.values(p.examples ?? {})[0];
  const given = first ? deref(doc, first as { $ref?: string; value?: unknown }) : undefined;
  if (given && "value" in given) return given.value;
  return exampleOf(doc, p.schema, "request");
};
const scalar = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.map(scalar).join(",") : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));

export function buildRequest(doc: OpenApi, entry: OpEntry, origin: string): SampleRequest {
  const server = serverUrlOf(doc, entry, origin);
  const params = parametersOf(doc, entry);
  let path = entry.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const p = params.find((q) => q.in === "path" && q.name === name);
    return p ? encodeURIComponent(scalar(paramExample(doc, p))) : `{${name}}`;
  });
  const query = new URLSearchParams();
  const headers: [string, string][] = [];
  const auth = authOf(doc, entry);
  for (const p of params) {
    if (p.in === "query" && (p.required || p.example !== undefined)) query.append(p.name, scalar(paramExample(doc, p)));
    else if (p.in === "header" && p.required && !/^(authorization|content-type|accept)$/i.test(p.name)) headers.push([p.name, scalar(paramExample(doc, p))]);
  }
  if (auth.query) query.append(auth.query[0], auth.query[1]);
  const qs = query.toString();
  if (qs) path += `?${qs}`;
  const body = deref(doc, entry.op.requestBody);
  const media = pickMedia(body?.content);
  let out: SampleRequest["body"];
  if (media) {
    const [type, m] = media;
    const value = mediaExample(doc, m, "request");
    if (/json/i.test(type)) out = { kind: "json", value, text: JSON.stringify(value ?? {}, null, 2) };
    else if (/x-www-form-urlencoded/i.test(type) && value && typeof value === "object") {
      const fields = Object.entries(value).map(([k, v]) => [k, scalar(v)] as [string, string]);
      out = { kind: "form", fields, text: new URLSearchParams(fields).toString() };
    } else if (typeof value === "string") out = { kind: "raw", text: value };
    headers.unshift(["Content-Type", type.split(";")[0]!]);
  }
  if (auth.header) headers.unshift(auth.header);
  return { method: entry.method.toUpperCase(), url: `${server}${path}`, headers, body: out };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function curl(r: SampleRequest): string {
  const lines = [`curl -X ${r.method} ${shq(r.url)}`];
  for (const [k, v] of r.headers) {
    if (k === "Authorization" && v.startsWith("Basic ")) lines.push(`  -u ${shq(v.slice(6))}`);
    else lines.push(`  -H ${shq(`${k}: ${v}`)}`);
  }
  if (r.body?.kind === "form") for (const [k, v] of r.body.fields) lines.push(`  --data-urlencode ${shq(`${k}=${v}`)}`);
  else if (r.body) {
    const compact = r.body.kind === "json" ? JSON.stringify(r.body.value) : r.body.text;
    lines.push(`  -d ${shq(r.body.kind === "json" && compact.length > 72 ? r.body.text : compact)}`);
  }
  return lines.join(" \\\n");
}
