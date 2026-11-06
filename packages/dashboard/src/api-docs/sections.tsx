// The page's sections around the operations: the introduction, authentication, a tag's heading, webhooks, models and guides.
import { lazy, Suspense, useMemo, type ComponentType } from "react";
import { Attribute, Body } from "./attributes";
import { CodeBox, Json, Pre } from "./code";
import { ContentBoundary, Heading } from "./components";
import { useDoc, useT, type Guide } from "./context";
import { absoluteUrl } from "./credentials";
import { Inline, Markdown } from "./markdown";
import { deref, pickMedia, scopesOf, serverUrlOf, type ModelEntry, type OAuthFlow, type SecurityScheme, type TagSection, type WebhookEntry } from "./openapi";
import { describe, mediaExample } from "./schema";
import { PLACEHOLDERS } from "./samples";
import { Method } from "./nav";

export function Intro() {
  const { doc, t, config } = useDoc();
  const { info } = doc;
  const servers = doc.servers ?? [];
  const links = [
    info.termsOfService && [t("termsOfService"), info.termsOfService],
    info.contact?.url && [info.contact.name ?? t("contact"), info.contact.url],
    info.contact?.email && [info.contact.email, `mailto:${info.contact.email}`],
    info.license && [info.license.name, info.license.url],
  ].filter(Boolean) as [string, string | undefined][];
  return (
    <section className="fd-section fd-intro" data-part="overview" aria-labelledby="overview">
      <h1 id="overview" className="fd-title">
        {config.title ?? info.title} <span className="fd-version">{info.version}</span>
      </h1>
      {info.summary && <p className="fd-lead">{info.summary}</p>}
      <Markdown text={info.description} headings={3} />
      {servers.length > 0 && (
        <div className="fd-servers">
          <Heading level={2} id="base-url">
            {t("baseUrl", { n: servers.length })}
          </Heading>
          <ul>
            {servers.map((s, i) => (
              <li key={i}>
                <code>{serverUrlOf(doc, { op: { servers: [s] }, pathItem: {} }, "")}</code>
                {s.description && (
                  <span>
                    {" "}
                    <Inline text={s.description} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {links.length > 0 && (
        <p className="fd-links">
          {links.map(([label, href], i) =>
            href ? (
              <a key={i} href={href} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ) : (
              <span key={i}>{label}</span>
            ),
          )}
        </p>
      )}
    </section>
  );
}

const FLOW_LABELS = { clientCredentials: "flowClientCredentials", authorizationCode: "flowAuthorizationCode", implicit: "flowImplicit", password: "flowPassword" } as const;

function Flow({ name, flow, used }: { name: keyof typeof FLOW_LABELS; flow: OAuthFlow; used: Map<string, number> }) {
  const { doc, t, preset } = useDoc();
  const scopes = Object.entries(flow.scopes ?? {});
  const server = serverUrlOf(doc, undefined, "");
  const tokenUrl = flow.tokenUrl ? absoluteUrl(preset?.oauth2?.tokenUrl ?? flow.tokenUrl, server) : undefined;
  return (
    <div className="fd-flow">
      <h4>{t(FLOW_LABELS[name])}</h4>
      <dl className="fd-dl">
        {tokenUrl && (
          <>
            <dt>{t("tokenUrl")}</dt>
            <dd>
              <code>{tokenUrl}</code>
            </dd>
          </>
        )}
        {flow.authorizationUrl && (
          <>
            <dt>{t("authorizationUrl")}</dt>
            <dd>
              <code>{flow.authorizationUrl}</code>
            </dd>
          </>
        )}
        {flow.refreshUrl && (
          <>
            <dt>{t("refreshUrl")}</dt>
            <dd>
              <code>{flow.refreshUrl}</code>
            </dd>
          </>
        )}
      </dl>
      {scopes.length > 0 && (
        <div className="fd-table">
          <table className="fd-codes">
            <thead>
              <tr>
                <th>{t("scope")}</th>
                <th>{t("meaning")}</th>
                <th>{t("usedBy")}</th>
              </tr>
            </thead>
            <tbody>
              {scopes.map(([scope, description]) => (
                <tr key={scope}>
                  <td>
                    <code>{scope}</code>
                  </td>
                  <td>
                    <Inline text={description} />
                  </td>
                  <td>{used.get(scope) === 1 ? t("operationsOne") : used.get(scope) ? t("operationsCount", { n: used.get(scope)! }) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {name === "clientCredentials" && tokenUrl && (
        <CodeBox
          label={t("tokenRequest")}
          title={t("tokenRequest")}
          tabs={[
            {
              id: "curl",
              label: "cURL",
              text: tokenRequest(tokenUrl, Object.keys(flow.scopes ?? {}), preset?.oauth2?.extraParams),
              content: <Pre>{tokenRequest(tokenUrl, Object.keys(flow.scopes ?? {}), preset?.oauth2?.extraParams)}</Pre>,
            },
          ]}
        />
      )}
    </div>
  );
}

function tokenRequest(url: string, scopes: string[], extra: Record<string, string> | undefined) {
  const lines = [`curl -X POST '${url}'`, `  -u 'YOUR_CLIENT_ID:YOUR_CLIENT_SECRET'`, `  -d 'grant_type=client_credentials'`];
  if (scopes.length) lines.push(`  -d 'scope=${scopes.slice(0, 3).join(" ")}'`);
  for (const [k, v] of Object.entries(extra ?? {})) lines.push(`  -d '${k}=${v}'`);
  return lines.join(" \\\n");
}

export function Authentication() {
  const { doc, model, t, authorize, site, config } = useDoc();
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of model.ops) for (const s of scopesOf(doc, o.op)) m.set(s, (m.get(s) ?? 0) + 1);
    return m;
  }, [doc, model]);
  if (!model.schemes.length) return null;
  return (
    <section className="fd-section" data-spy={site.authentication!.anchor} data-part="authentication" aria-labelledby={site.authentication!.anchor}>
      <Heading level={2} id={site.authentication!.anchor} className="fd-h2">
        {t("authentication")}
      </Heading>
      {model.schemes.map(([name, s]) => (
        <SchemeView key={name} name={name} scheme={s} used={used} />
      ))}
      {config.controls?.authorize !== false && (
        <p>
          <button type="button" className="fd-btn fd-btn-primary" onClick={authorize}>
            {t("authorize")}
          </button>
        </p>
      )}
    </section>
  );
}

function SchemeView({ name, scheme, used }: { name: string; scheme: SecurityScheme; used: Map<string, number> }) {
  const t = useT();
  const kind =
    scheme.type === "http" ? `HTTP ${scheme.scheme ?? ""}`.trim() : scheme.type === "apiKey" ? t("apiKey") : scheme.type === "oauth2" ? "OAuth 2.0" : scheme.type === "openIdConnect" ? "OpenID Connect" : scheme.type;
  const flows = scheme.flows ?? {};
  return (
    <div className="fd-scheme">
      <Heading level={3} id={`scheme-${name}`} label={name}>
        <code>{name}</code> <span className="fd-type">{kind}</span>
      </Heading>
      <Markdown text={scheme.description} />
      {scheme.type === "http" && scheme.scheme?.toLowerCase() === "bearer" && (
        <p>
          {t("sendBearer")} <code>Authorization: Bearer {PLACEHOLDERS.token}</code>
          {scheme.bearerFormat && (
            <>
              {" "}
              ({scheme.bearerFormat})
            </>
          )}
        </p>
      )}
      {scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic" && (
        <p>
          {t("sendBearer")} <code>Authorization: Basic base64({PLACEHOLDERS.user}:{PLACEHOLDERS.password})</code>
        </p>
      )}
      {scheme.type === "apiKey" && (
        <p>
          {t("sendApiKey", { where: scheme.in ?? "header" })} <code>{scheme.name}</code>
        </p>
      )}
      {scheme.type === "openIdConnect" && scheme.openIdConnectUrl && (
        <p>
          {t("discovery")} <code>{scheme.openIdConnectUrl}</code>
        </p>
      )}
      {(Object.keys(FLOW_LABELS) as (keyof typeof FLOW_LABELS)[]).map((f) => flows[f] && <Flow key={f} name={f} flow={flows[f]!} used={used} />)}
    </div>
  );
}

/** A tag's title and description: the top of its page, or of its part of the single page. */
export function TagHeader({ section, asTitle }: { section: TagSection; asTitle?: boolean }) {
  const { t, site } = useDoc();
  const anchor = site.tag.get(section)?.anchor;
  return (
    <>
      {asTitle ? (
        <h1 className="fd-title">{section.title}</h1>
      ) : (
        <Heading level={2} id={anchor || undefined} className="fd-h2">
          {section.title}
        </Heading>
      )}
      <Markdown text={section.description} headings={3} />
      {section.externalDocs?.url && (
        <p>
          <a href={section.externalDocs.url} target="_blank" rel="noopener noreferrer">
            {section.externalDocs.description ?? t("moreDocs")}
          </a>
        </p>
      )}
    </>
  );
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h${s % 3600 ? ` ${Math.round((s % 3600) / 60)} min` : ""}`;
  return `${Math.round(s / 86400)} ${s / 86400 === 1 ? "day" : "days"}`;
}

const VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// \`secret\` is the endpoint's signing secret (whsec_...), \`rawBody\` the request body exactly as received.
function verify(headers, rawBody, secret) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // too old, or from the future
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(\`\${id}.\${timestamp}.\${rawBody}\`).digest();
  return headers["webhook-signature"].split(" ").some((part) => {
    const [version, signature] = part.split(",");
    const given = Buffer.from(signature ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}`;

function WebhookSigning() {
  const { doc, t } = useDoc();
  const s = doc["x-webhooks-signing"];
  if (!s) return null;
  const waits = Array.from({ length: Math.max(0, Math.min(s.retry.attempts - 1, 20)) }, (_, i) => Math.min(s.retry.maxDelayMs, s.retry.delayMs * s.retry.factor ** i));
  return (
    <div className="fd-signing">
      <Heading level={3} id="envelope">
        {t("webhookEnvelope")}
      </Heading>
      <p>{t("webhookEnvelopeText")}</p>
      <ul className="fd-attrs">
        {(["type", "timestamp", "data"] as const).map((k) => (
          <li className="fd-attr" key={k}>
            <div className="fd-attr-head">
              <code className="fd-attr-name">{k}</code>
              <span className="fd-type">{k === "data" ? "object" : "string"}</span>
            </div>
            <div className="fd-attr-body">
              <Markdown text={s.envelope[k]} />
            </div>
          </li>
        ))}
      </ul>
      <Heading level={3} id="headers">
        {t("webhookHeaders")}
      </Heading>
      <div className="fd-table">
        <table className="fd-codes">
          <tbody>
            <tr>
              <td>
                <code>webhook-id</code>
              </td>
              <td>{t("headerWebhookId")}</td>
            </tr>
            <tr>
              <td>
                <code>webhook-timestamp</code>
              </td>
              <td>{t("headerWebhookTimestamp")}</td>
            </tr>
            <tr>
              <td>
                <code>webhook-signature</code>
              </td>
              <td>{t("headerWebhookSignature")}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Heading level={3} id="verify">
        {t("webhookVerify")}
      </Heading>
      <ol className="fd-steps">
        <li>{t("verifyStep1")}</li>
        <li>{t("verifyStep2")}</li>
        <li>{t("verifyStep3", { age: formatMs(s.toleranceMs) })}</li>
      </ol>
      <CodeBox label="Node.js" title="Node.js" tabs={[{ id: "node", label: "Node.js", text: VERIFY, content: <Pre>{VERIFY}</Pre> }]} />
      <Heading level={3} id="retries">
        {t("webhookRetries")}
      </Heading>
      <p>{t("webhookRetriesText", { attempts: s.retry.attempts, timeout: formatMs(s.retry.timeoutMs) })}</p>
      <div className="fd-table">
        <table className="fd-codes">
          <thead>
            <tr>
              <th>{t("attempt")}</th>
              <th>{t("sentAfter")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>1</td>
              <td>{t("immediately")}</td>
            </tr>
            {waits.map((w, i) => (
              <tr key={i}>
                <td>{i + 2}</td>
                <td>{t("upTo", { time: formatMs(w) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A tag's page when every operation has a page of its own: what it is, then its operations. */
export function TagIndex({ section }: { section: TagSection }) {
  const { site, href, t } = useDoc();
  return (
    <div className="fd-endpoints" data-part="tag-endpoints">
      <Heading level={2} id="endpoints">
        {t("endpoints")}
      </Heading>
      <ul>
        {section.ops.map((o) => (
          <li key={o.id}>
            <a href={href(site.op.get(o))} data-part="endpoint-link">
              <Method method={o.method} />
              <span className="fd-endpoints-title">{o.op.summary ?? o.operationId}</span>
              <code>{o.path}</code>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WebhookEvent({ event }: { event: WebhookEntry }) {
  const { doc, t, site } = useDoc();
  const anchor = site.webhook.get(event)!.anchor;
  const body = deref(doc, event.op.requestBody);
  const media = pickMedia(body?.content);
  const example = media ? mediaExample(doc, media[1], "response") : undefined;
  const text = example === undefined ? undefined : JSON.stringify(example, null, 2);
  return (
    <article className="fd-event" data-spy={anchor} data-part="webhook">
      <Heading level={3} id={anchor} className="fd-op-title">
        <code>{event.name}</code>
        {event.op.deprecated && <span className="fd-flag fd-flag-warn">{t("deprecated")}</span>}
      </Heading>
      {event.op.summary && (
        <p className="fd-lead">
          <Inline text={event.op.summary} />
        </p>
      )}
      <Markdown text={event.op.description} />
      <div className="fd-op-grid">
        <div className="fd-op-doc">
          {media?.[1].schema && (
            <>
              <h4>{t("payload")}</h4>
              <Body doc={doc} schema={media[1].schema} />
            </>
          )}
        </div>
        <div className="fd-op-code">
          {text && <CodeBox label={t("example")} title={t("example")} tabs={[{ id: "json", label: "JSON", text, content: <pre><code><Json text={text} /></code></pre> }]} />}
        </div>
      </div>
    </article>
  );
}

export function Webhooks({ events, asTitle }: { events: WebhookEntry[]; asTitle?: boolean }) {
  const { t, doc, site } = useDoc();
  if (!events.length) return null;
  const anchor = site.webhooks?.anchor;
  return (
    <section className="fd-section" data-spy={anchor || undefined} data-part="webhooks">
      {asTitle ? (
        <h1 className="fd-title">{t("webhooks")}</h1>
      ) : (
        <Heading level={2} id={anchor || undefined} className="fd-h2">
          {t("webhooks")}
        </Heading>
      )}
      <p>{t("webhooksIntro", { name: doc.info.title })}</p>
      <WebhookSigning />
      <Heading level={2} id={anchor ? `${anchor}/events` : "events"}>
        {t("events")}
      </Heading>
      {events.map((e) => (
        <WebhookEvent key={e.id} event={e} />
      ))}
    </section>
  );
}

export function Models({ models, asTitle }: { models: ModelEntry[]; asTitle?: boolean }) {
  const { t, doc, site } = useDoc();
  if (!models.length) return null;
  const anchor = site.models?.anchor;
  return (
    <section className="fd-section" data-spy={anchor || undefined} data-part="models">
      {asTitle ? (
        <h1 className="fd-title">{t("models")}</h1>
      ) : (
        <Heading level={2} id={anchor || undefined} className="fd-h2">
          {t("models")}
        </Heading>
      )}
      {models.map((m) => {
        const info = describe(doc, { $ref: `#/components/schemas/${encodeURIComponent(m.name)}` });
        const example = mediaExample(doc, { schema: { $ref: `#/components/schemas/${encodeURIComponent(m.name)}` } }, "response");
        const text = example === undefined ? undefined : JSON.stringify(example, null, 2);
        const at = site.model.get(m)!.anchor;
        return (
          <article className="fd-model" data-spy={at} key={m.id} data-part="model">
            <Heading level={3} id={at} className="fd-op-title">
              <code>{m.name}</code> <span className="fd-type">{info.type === m.name ? "object" : info.type}</span>
            </Heading>
            <div className="fd-op-grid">
              <div className="fd-op-doc">
                <Markdown text={info.description} />
                {info.children?.kind === "props" ? <Body doc={doc} schema={{ $ref: `#/components/schemas/${encodeURIComponent(m.name)}` }} /> : <Attribute doc={doc} name={m.name} schema={m.schema} seen={[]} />}
              </div>
              <div className="fd-op-code">
                {text && <CodeBox label={t("example")} title={t("example")} tabs={[{ id: "json", label: "JSON", text, content: <pre><code><Json text={text} /></code></pre> }]} />}
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}

/** A guide's own `# Title` is its page's title. */
const PageTitle = ({ children }: { children?: React.ReactNode }) => <h1 className="fd-title">{children}</h1>;

/** One guide, a page of its own (or its part of the single page): its MDX, with the components it can use and a boundary around it. */
export function GuideView({ guide, asPage }: { guide: Guide; asPage?: boolean }) {
  const { t, mdx, dev, site } = useDoc();
  const Content = useMemo(() => (guide.content ?? lazy(guide.load!)) as ComponentType<{ components?: object }>, [guide]);
  const anchor = site.guide.get(guide.slug)?.anchor;
  return (
    <section className="fd-section fd-guide" data-spy={anchor || undefined} id={anchor || undefined} aria-label={guide.title} data-part="guide">
      <div className="fd-prose" data-page={asPage ? "" : undefined}>
        <ContentBoundary file={guide.file ?? `forge/docs/${guide.slug}.mdx`} dev={dev}>
          <Suspense fallback={<p className="fd-note">{t("loading")}</p>}>
            <Content components={asPage ? { ...mdx, h1: PageTitle } : mdx} />
          </Suspense>
        </ContentBoundary>
      </div>
    </section>
  );
}
