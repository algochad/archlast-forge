// One operation: what it is and needs (security, parameters, body, responses with their error codes) beside a column of code: samples in the
// visitor's language, the responses' examples, and the "Try it" button.
import { memo, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Attribute, Body, HeaderRows } from "./attributes";
import { CodeBox, CopyButton, Json, Pre, type Tab } from "./code";
import { ContentBoundary, Heading } from "./components";
import type { CodeSampleLanguage } from "./contract";
import { useDoc, useStore, useT } from "./context";
import { Inline, Markdown } from "./markdown";
import { Method } from "./nav";
import { deref, parametersOf, pickMedia, scopesOf, securityOf, serverUrlOf, type OpEntry, type Parameter, type ResponseObject } from "./openapi";
import { mediaExample } from "./schema";
import { buildRequest, curl, LANGUAGE_LABELS, type SampleRequest } from "./samples";

type Languages = typeof import("./languages");
let languages: Languages | undefined;

/** The sample for a language: cURL at once, the rest when their code has loaded. */
function useSample(lang: CodeSampleLanguage | undefined, req: SampleRequest): string | undefined {
  const [, loaded] = useState(0);
  useEffect(() => {
    if (lang && lang !== "curl" && !languages) void import("./languages").then((m) => ((languages = m), loaded(1)));
  }, [lang]);
  if (!lang) return undefined;
  if (lang === "curl") return curl(req);
  return languages?.generate(lang, req);
}

function Samples({ entry }: { entry: OpEntry }) {
  const { doc, origin, languages: langs, lang: store, t } = useDoc();
  const picked = useStore(store);
  const req = useMemo(() => buildRequest(doc, entry, origin), [doc, entry, origin]);
  const custom = entry.op["x-codeSamples"] ?? [];
  const ids = [...custom.map((s, i) => `x-${s.label ?? s.lang}-${i}`), ...langs];
  const active = ids.find((id) => id === picked) ?? ids.find((id) => id.replace(/-\d+$/, "") === picked?.replace(/-\d+$/, "")) ?? ids[0];
  const generated = useSample(langs.includes(active as CodeSampleLanguage) ? (active as CodeSampleLanguage) : undefined, req);
  const tabs: Tab[] = [
    ...custom.map((s, i) => {
      const id = `x-${s.label ?? s.lang}-${i}`;
      return { id, label: s.label ?? s.lang, text: id === active ? s.source : undefined, content: id === active ? <Pre>{s.source}</Pre> : null };
    }),
    ...langs.map((l) => ({ id: l, label: LANGUAGE_LABELS[l], text: l === active ? generated : undefined, content: l === active ? <Pre>{generated ?? t("loading")}</Pre> : null })),
  ];
  return (
    <CodeBox
      label={t("codeSamples")}
      tabs={tabs}
      active={active}
      onTab={store.set}
    />
  );
}

/** The examples of an operation's responses, one tab per status. */
function ResponseExamples({ entry }: { entry: OpEntry }) {
  const { doc, t } = useDoc();
  const examples = useMemo(() => {
    const out: { status: string; type: string; text: string }[] = [];
    for (const [status, raw] of Object.entries(entry.op.responses ?? {})) {
      const media = pickMedia(deref(doc, raw)?.content);
      if (!media) continue;
      const value = mediaExample(doc, media[1], "response");
      if (value === undefined) continue;
      out.push({ status, type: media[0], text: typeof value === "string" && !/json/i.test(media[0]) ? value : JSON.stringify(value, null, 2) });
    }
    return out;
  }, [doc, entry]);
  const [status, setStatus] = useState<string>();
  if (!examples.length) return null;
  const tabs: Tab[] = examples.map((e) => ({
    id: e.status,
    label: e.status,
    text: e.text,
    content: (
      <pre>
        <code>{/json/i.test(e.type) ? <Json text={e.text} /> : e.text}</code>
      </pre>
    ),
  }));
  const first = examples.find((e) => e.status.startsWith("2"))?.status ?? examples[0]!.status;
  return <CodeBox label={t("responseExamples")} title={t("response")} tabs={tabs} active={status ?? first} onTab={setStatus} />;
}

/** Where an operation's sections are: one id each on its own page, prefixed by its anchor where several operations share a page. */
type Ids = { of: (name: string) => string; toc: boolean };

/** What the operation needs: its security schemes and the scopes, each scope's meaning on hover. */
function Authorizations({ entry, ids }: { entry: OpEntry; ids: Ids }) {
  const { doc, model, t, href, site, config, authorize } = useDoc();
  if (!model.schemes.length) return null;
  const required = securityOf(doc, entry.op);
  const explicit = entry.op.security !== undefined;
  if (!required.length) return explicit ? <p className="fd-security">{t("noAuth")}</p> : null;
  const optional = required.some((r) => !Object.keys(r).length);
  const alternatives = required.filter((r) => Object.keys(r).length);
  const scopes = scopesOf(doc, entry.op);
  const meaning = (scope: string) => {
    for (const [, s] of model.schemes) for (const flow of Object.values(s.flows ?? {})) if (flow?.scopes?.[scope]) return flow.scopes[scope];
    return undefined;
  };
  return (
    <div className="fd-authorizations" data-part="authorizations">
      <Heading level={3} id={ids.of("authorizations")} toc={ids.toc}>
        {t("authorizations")}
      </Heading>
      <div className="fd-security">
        {alternatives.map((r, i) => (
          <span className="fd-chip fd-chip-auth" key={i}>
            {Object.keys(r).map((scheme) => (
              <a key={scheme} href={href(site.authentication)}>
                {scheme}
              </a>
            ))}
          </span>
        ))}
        {optional && <span className="fd-note">{t("authOptional")}</span>}
        {config.controls?.authorize === "operation" && (
          <button type="button" className="fd-btn fd-btn-ghost" onClick={authorize}>
            {t("authorize")}
          </button>
        )}
      </div>
      {scopes.length > 0 && (
        <p className="fd-scopes-line" data-part="scopes">
          <span className="fd-chip-label">{t("scopesLabel")}</span>{" "}
          {scopes.map((s) => (
            <code key={s} title={meaning(s)}>
              {s}
            </code>
          ))}
        </p>
      )}
    </div>
  );
}

const LOCATIONS = ["path", "query", "header", "cookie"] as const;

function Parameters({ entry, ids }: { entry: OpEntry; ids: Ids }) {
  const { doc, t } = useDoc();
  const params = parametersOf(doc, entry);
  if (!params.length) return null;
  const titles = { path: t("pathParameters"), query: t("queryParameters"), header: t("headerParameters"), cookie: t("cookieParameters") };
  return (
    <>
      {LOCATIONS.map((where) => {
        const list = params.filter((p) => p.in === where);
        if (!list.length) return null;
        return (
          <div key={where}>
            <Heading level={3} id={ids.of(`${where}-parameters`)} toc={ids.toc}>
              {titles[where]}
            </Heading>
            <ul className="fd-attrs">
              {list.map((p: Parameter) => (
                <Attribute key={p.name} doc={doc} name={p.name} schema={p.schema ?? pickMedia(p.content)?.[1].schema} required={p.required || where === "path"} description={p.description} example={p.example} deprecated={p.deprecated} />
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function RequestBody({ entry, ids }: { entry: OpEntry; ids: Ids }) {
  const { doc, t } = useDoc();
  const body = deref(doc, entry.op.requestBody);
  const media = pickMedia(body?.content);
  if (!body || !media) return null;
  const others = Object.keys(body.content ?? {}).filter((c) => c !== media[0]);
  return (
    <div>
      <Heading level={3} id={ids.of("body")} toc={ids.toc} label={t("requestBody")}>
        {t("requestBody")} <code className="fd-ctype">{media[0]}</code>
        {body.required ? <span className="fd-flag fd-flag-req">{t("required")}</span> : <span className="fd-flag">{t("optional")}</span>}
      </Heading>
      <Markdown text={body.description} />
      <Body doc={doc} schema={media[1].schema} />
      {others.length > 0 && (
        <p className="fd-note">
          {t("alsoAccepts")} {others.map((c, i) => [i ? ", " : "", <code key={c}>{c}</code>])}
        </p>
      )}
    </div>
  );
}

function Responses({ entry, ids }: { entry: OpEntry; ids: Ids }) {
  const { doc, t, config } = useDoc();
  const headersOpen = config.content?.responseHeaders === "open";
  const responses = Object.entries(entry.op.responses ?? {});
  const codes = entry.op["x-error-codes"] ?? [];
  const shown = new Set(responses.map(([s]) => s));
  const orphan = codes.filter((c) => !shown.has(c.status));
  if (!responses.length && !codes.length) return null;
  return (
    <div>
      <Heading level={3} id={ids.of("responses")} toc={ids.toc}>
        {t("responses")}
      </Heading>
      {responses.map(([status, raw]) => {
        const r: ResponseObject = deref(doc, raw) ?? {};
        const media = pickMedia(r.content);
        const mine = codes.filter((c) => c.status === status);
        const ok = status.startsWith("2");
        return (
          <div className="fd-resp" key={status}>
            <div className="fd-resp-head">
              <span className={`fd-status fd-s${status[0]}`}>{status}</span>
              <span className="fd-resp-desc">
                <Inline text={r.description} />
              </span>
              {media && <code className="fd-ctype">{media[0]}</code>}
            </div>
            {r.headers && Object.keys(r.headers).length > 0 && (
              <details className="fd-nested" open={headersOpen && ok}>
                <summary>{t("responseHeaders", { n: Object.keys(r.headers).length })}</summary>
                <HeaderRows doc={doc} headers={r.headers} />
              </details>
            )}
            {media?.[1].schema && (
              <details className="fd-nested" open={ok}>
                <summary>{t("responseBody")}</summary>
                <Body doc={doc} schema={media[1].schema} />
              </details>
            )}
            {mine.length > 0 && <ErrorCodes codes={mine} />}
          </div>
        );
      })}
      {orphan.length > 0 && <ErrorCodes codes={orphan} withStatus />}
    </div>
  );
}

function ErrorCodes({ codes, withStatus }: { codes: { status: string; code: string; description?: string }[]; withStatus?: boolean }) {
  const t = useT();
  return (
    <div className="fd-table">
      <table className="fd-codes">
        <thead>
          <tr>
            {withStatus && <th>{t("status")}</th>}
            <th>{t("errorCode")}</th>
            <th>{t("meaning")}</th>
          </tr>
        </thead>
        <tbody>
          {codes.map((c) => (
            <tr key={`${c.status}:${c.code}`}>
              {withStatus && <td>{c.status}</td>}
              <td>
                <code>{c.code}</code>
              </td>
              <td>
                <Inline text={c.description} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The method, the full address and "Try it", in one row. */
function EndpointBar({ entry }: { entry: OpEntry }) {
  const { doc, origin, tryIt, t } = useDoc();
  const url = `${serverUrlOf(doc, entry, origin)}${entry.path}`;
  return (
    <div className="fd-endpoint" data-part="endpoint-bar">
      <Method method={entry.method} />
      <code className="fd-endpoint-url" title={url}>
        <span className="fd-endpoint-server">{serverUrlOf(doc, entry, origin)}</span>
        <span className="fd-endpoint-path">{entry.path}</span>
      </code>
      <span className="fd-endpoint-actions">
        <CopyButton text={url} />
        {tryIt.enabled && (
          <button type="button" className="fd-btn fd-btn-primary fd-try" onClick={(e) => tryIt.open(entry, e.currentTarget)} onPointerEnter={tryIt.prefetch} onFocus={tryIt.prefetch} data-part="try-it">
            {t("tryIt")}
          </button>
        )}
      </span>
    </div>
  );
}

export const OperationView = memo(function OperationView({ entry, asPage }: { entry: OpEntry; asPage?: boolean }) {
  const { slots, t, site, dev } = useDoc();
  const anchor = site.op.get(entry)?.anchor ?? "";
  const ids: Ids = { of: (name) => (anchor ? `${anchor}/${name}` : name), toc: !!asPage };
  const Before = slots["operation-before"];
  const After = slots["operation-after"];
  const slotProps = { operation: entry.op, path: entry.path, method: entry.method, tag: entry.tag };
  const slot = (S: typeof Before, name: string): ReactNode =>
    S && (
      <div className="fd-slot" data-part={`slot-${name}`}>
        <ContentBoundary file={`forge/docs/_slots/${name}.mdx`} dev={dev}>
          <Suspense fallback={null}>
            <S {...slotProps} />
          </Suspense>
        </ContentBoundary>
      </div>
    );
  const title = (
    <>
      {entry.op.summary ?? entry.operationId}
      {entry.op.deprecated && <span className="fd-flag fd-flag-warn">{t("deprecated")}</span>}
      {entry.internal && <span className="fd-flag fd-flag-internal">{t("internal")}</span>}
    </>
  );
  return (
    <section className="fd-op" id={asPage ? undefined : anchor || undefined} data-spy={anchor || undefined} data-part="operation" data-method={entry.method}>
      <div className="fd-op-grid">
        <div className="fd-op-doc">
          {asPage ? (
            <h1 className="fd-title fd-op-title">{title}</h1>
          ) : (
            <Heading level={2} id={anchor ? `${anchor}~h` : undefined} className="fd-op-title">
              {title}
            </Heading>
          )}
          <EndpointBar entry={entry} />
          <Markdown text={entry.op.description} />
          {slot(Before, "operation-before")}
          <Authorizations entry={entry} ids={ids} />
          <Parameters entry={entry} ids={ids} />
          <RequestBody entry={entry} ids={ids} />
          <Responses entry={entry} ids={ids} />
          {slot(After, "operation-after")}
        </div>
        <div className="fd-op-code" data-part="code-panel">
          <Samples entry={entry} />
          <ResponseExamples entry={entry} />
        </div>
      </div>
    </section>
  );
});
