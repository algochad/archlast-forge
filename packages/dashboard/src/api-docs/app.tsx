// The API docs page: the OpenAPI document the engine generates, read as a reference in the docs site's style, plus the guide and the app's
// own pages (forge/docs/*.mdx), compiled when the page is built.
import { Fragment, lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error made by host.ts's build: the app's forge/docs pages, each loaded when it is opened
import pages from "forge-docs:pages";
import Guide from "./guide.mdx";
import "./styles.css";

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; anyOf?: Schema[]; $ref?: string; pattern?: string; description?: string; enum?: string[] };
type Param = { name: string; in: string; required?: boolean; schema: Schema; description?: string };
type Op = {
  operationId: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Param[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, { description: string; content?: Record<string, { schema: Schema }> }>;
};
type OpenApi = { info: { title: string; version: string }; servers?: { url: string }[]; paths: Record<string, Record<string, Op>>; components?: { schemas?: Record<string, Schema> } };
type Page = { slug: string; title: string; load: () => Promise<{ default: ComponentType }> };

const BASE = document.documentElement.dataset.base ?? "";
const appPages = (pages as Page[]).map((p) => ({ ...p, Content: lazy(p.load) }));

/** Where the hash points: the guide, one of the app's pages, or an operation. */
function useRoute() {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const on = () => (setHash(location.hash.slice(1)), window.scrollTo(0, 0));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function App() {
  const [doc, setDoc] = useState<OpenApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const route = useRoute();
  useEffect(() => {
    fetch(`${BASE}/openapi.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then(setDoc, (e: Error) => setError(e.message));
  }, []);
  const ops = useMemo(() => (doc ? Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op }))) : []), [doc]);
  const groups = useMemo(() => {
    const g = new Map<string, Map<string, typeof ops>>([
      ["Functions", new Map()],
      ["HTTP", new Map()],
    ]);
    const needle = q.toLowerCase();
    for (const o of ops) {
      if (needle && !`${o.path} ${o.op.summary ?? ""}`.toLowerCase().includes(needle)) continue;
      const section = o.path.startsWith("/rpc/") ? "Functions" : "HTTP";
      const tag = o.op.tags?.[0] ?? "Other";
      const bucket = g.get(section)!;
      bucket.set(tag, [...(bucket.get(tag) ?? []), o]);
    }
    return g;
  }, [ops, q]);
  const current = route.startsWith("op/") ? ops.find((o) => o.op.operationId === route.slice(3)) : undefined;
  const page = route.startsWith("page/") ? appPages.find((p) => p.slug === route.slice(5)) : undefined;

  return (
    <>
      <header className="top">
        <span className="title">{doc?.info.title ?? "API"}</span>
        {doc && <span className="version">{doc.info.version}</span>}
        <a className="btn push" href={`${BASE}/openapi.json`}>
          openapi.json
        </a>
        <a className="btn primary" href={`${BASE}/explorer`}>
          Try it in the explorer
        </a>
      </header>
      <div className="layout">
        <nav className="side" aria-label="API">
          <input type="search" placeholder="Find an endpoint…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an endpoint" />
          <h4>Guide</h4>
          <a href="#" className={!route ? "on" : ""}>
            Calling this API
          </a>
          {appPages.map((p) => (
            <a key={p.slug} href={`#page/${p.slug}`} className={page?.slug === p.slug ? "on" : ""}>
              {p.title}
            </a>
          ))}
          {[...groups].map(([section, tags]) =>
            tags.size ? (
              <Fragment key={section}>
                <h4>{section}</h4>
                {[...tags].map(([tag, list]) => (
                  <Fragment key={tag}>
                    <div className="group">{tag}</div>
                    {list.map((o) => (
                      <a key={o.op.operationId} href={`#op/${o.op.operationId}`} className={current?.op === o.op ? "on" : ""} title={`${o.method.toUpperCase()} ${o.path}`}>
                        <span className={`method ${o.method}`}>{o.method.toUpperCase()}</span>
                        <span>{o.path.slice(5) /* without "/rpc/" or "/http" */}</span>
                      </a>
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ) : null,
          )}
        </nav>
        <main className="main">
          {error ? (
            <p className="empty">The API description didn't load: {error}</p>
          ) : !doc ? (
            <p className="empty">Loading…</p>
          ) : current ? (
            <Operation path={current.path} method={current.method} op={current.op} doc={doc} />
          ) : page ? (
            <Suspense fallback={<p className="empty">Loading…</p>}>
              <article>
                <page.Content />
              </article>
            </Suspense>
          ) : (
            <article>
              <Guide />
              <p className="muted">
                {ops.length} endpoints · <a href={`${BASE}/openapi.json`}>OpenAPI 3.1</a>
              </p>
            </article>
          )}
        </main>
      </div>
    </>
  );
}

const resolve = (s: Schema, doc: OpenApi): Schema => (s.$ref ? (doc.components?.schemas?.[s.$ref.split("/").pop()!] ?? {}) : s);

function typeOf(s: Schema, doc: OpenApi): string {
  const r = resolve(s, doc);
  if (r.anyOf) return r.anyOf.map((m) => typeOf(m, doc)).join(" | ");
  if (r.type === "array") return `${typeOf(r.items ?? {}, doc)}[]`;
  if (r.pattern?.match(/^\^(\w+):/)) return `Id<"${r.pattern.match(/^\^(\w+):/)![1]}">`;
  if (r.enum) return r.enum.map((e) => JSON.stringify(e)).join(" | ");
  return r.type ?? "any";
}

/** An object's fields as a table, nested objects inside; anything else as its type. */
function Fields({ schema, doc }: { schema: Schema; doc: OpenApi }): ReactNode {
  const s = resolve(schema, doc);
  const obj = s.type === "array" ? resolve(s.items ?? {}, doc) : s;
  if (obj.type !== "object" || !obj.properties || !Object.keys(obj.properties).length)
    return <p className="type">{obj.type === "object" ? "{}" : typeOf(s, doc)}</p>;
  return (
    <table className="fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(obj.properties).map(([name, p]) => {
          const inner = resolve(p, doc);
          const nested = inner.type === "object" || (inner.type === "array" && resolve(inner.items ?? {}, doc).type === "object");
          return (
            <tr key={name}>
              <td className="name">
                {name}
                {obj.required?.includes(name) && <span className="req">required</span>}
              </td>
              <td>
                <span className="type">{typeOf(p, doc)}</span>
                {inner.description && <div className="muted">{inner.description}</div>}
                {nested && (
                  <div className="nested">
                    <Fields schema={p} doc={doc} />
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A value that fits the schema, for the example request. */
function example(s: Schema, doc: OpenApi): unknown {
  const r = resolve(s, doc);
  if (r.anyOf) return example(r.anyOf[0]!, doc);
  if (r.type === "object") return Object.fromEntries(Object.entries(r.properties ?? {}).filter(([k]) => r.required?.includes(k)).map(([k, p]) => [k, example(p, doc)]));
  if (r.type === "array") return [example(r.items ?? {}, doc)];
  if (r.pattern?.match(/^\^(\w+):/)) return `${r.pattern.match(/^\^(\w+):/)![1]}:0123456789abcdef0123456789abcdef`;
  return r.type === "number" ? 1 : r.type === "boolean" ? true : r.type === "null" ? null : "text";
}

function Operation({ path, method, op, doc }: { path: string; method: string; op: Op; doc: OpenApi }) {
  const server = doc.servers?.[0]?.url ?? location.origin;
  const body = op.requestBody?.content["application/json"]?.schema;
  const curl = [`curl -X ${method.toUpperCase()} '${server}${path.replace(/\{(\w+)\}/g, "<$1>")}'`, ...(body ? [`  -H 'content-type: application/json'`, `  -d '${JSON.stringify(example(body, doc))}'`] : [])].join(" \\\n");
  const params = op.parameters ?? [];
  return (
    <article>
      <div className="op-head">
        <span className={`method ${method}`}>{method.toUpperCase()}</span>
        <span className="path">{path}</span>
      </div>
      <h1>{op.summary ?? op.operationId}</h1>
      {op.description && <p className="lead">{op.description}</p>}
      {params.length > 0 && (
        <>
          <h2>Parameters</h2>
          <table className="fields">
            <thead>
              <tr>
                <th>Name</th>
                <th>In</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => (
                <tr key={`${p.in}:${p.name}`}>
                  <td className="name">
                    {p.name}
                    {p.required && <span className="req">required</span>}
                  </td>
                  <td className="muted">{p.in}</td>
                  <td>
                    <span className="type">{typeOf(p.schema, doc)}</span>
                    {p.description && <div className="muted">{p.description}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {body && (
        <>
          <h2>Body {op.requestBody?.required ? "" : <span className="muted">(optional)</span>}</h2>
          <Fields schema={body} doc={doc} />
        </>
      )}
      <h2>Responses</h2>
      {Object.entries(op.responses).map(([status, r]) => {
        const schema = r.content?.["application/json"]?.schema;
        return (
          <section key={status}>
            <h3>
              <span className="status">{status}</span> <span className="muted">{r.description}</span>
            </h3>
            {schema && !schema.$ref?.endsWith("/ErrorBody") && <Fields schema={schema} doc={doc} />}
          </section>
        );
      })}
      <h2>Example</h2>
      <pre>
        <code>{curl}</code>
      </pre>
    </article>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
