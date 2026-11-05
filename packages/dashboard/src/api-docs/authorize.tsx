// The Authorize panel: what the visitor enters for each security scheme the document declares, kept in the page's credential store (and so
// in the request builder). OAuth2 client credentials fetch their token here, from the token endpoint and nowhere else.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useDoc } from "./context";
import { absoluteUrl, fetchToken, useCredentials } from "./credentials";
import { Markdown } from "./markdown";
import { serverUrlOf, type SecurityScheme } from "./openapi";

function Field({ label, value, onChange, secret, name, autoComplete }: { label: string; value: string; onChange: (v: string) => void; secret?: boolean; name: string; autoComplete?: string }) {
  return (
    <label className="fd-field">
      <span>{label}</span>
      <input name={name} type={secret ? "password" : "text"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete ?? "off"} spellCheck={false} autoCapitalize="off" />
    </label>
  );
}

/** Whether a token's expiry has passed. */
const expired = (c: { expiresAt?: number } | undefined) => !!c?.expiresAt && c.expiresAt <= Date.now();

function Bearer({ name, scheme }: { name: string; scheme: SecurityScheme }) {
  const { credentials, t } = useDoc();
  const cred = useCredentials(credentials)[name];
  const basic = scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic";
  const saved = cred?.type === "http" ? cred : undefined;
  const [token, setToken] = useState(saved?.token ?? "");
  const [user, setUser] = useState(saved?.username ?? "");
  const [password, setPassword] = useState(saved?.password ?? "");
  const [note, setNote] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    credentials.update(name, basic ? { type: "http", username: user, password } : { type: "http", token: token.trim() });
    setNote(t("saved"));
  };
  return (
    <form onSubmit={submit} className="fd-form">
      {basic ? (
        <>
          <Field label={t("username")} name="username" value={user} onChange={setUser} />
          <Field label={t("password")} name="password" value={password} onChange={setPassword} secret />
        </>
      ) : (
        <Field label={t("bearerToken")} name="token" value={token} onChange={setToken} secret />
      )}
      <div className="fd-form-actions">
        <button type="submit" className="fd-btn fd-btn-primary">
          {t("save")}
        </button>
        {cred && (
          <button type="button" className="fd-btn" onClick={() => (credentials.update(name, null), setToken(""), setUser(""), setPassword(""), setNote(""))}>
            {t("clear")}
          </button>
        )}
        <span role="status" className="fd-note">
          {note}
        </span>
      </div>
    </form>
  );
}

function ApiKey({ name }: { name: string }) {
  const { credentials, t } = useDoc();
  const cred = useCredentials(credentials)[name];
  const [value, setValue] = useState(cred?.type === "apiKey" ? cred.value : "");
  const [note, setNote] = useState("");
  return (
    <form
      className="fd-form"
      onSubmit={(e) => {
        e.preventDefault();
        credentials.update(name, { type: "apiKey", value: value.trim() });
        setNote(t("saved"));
      }}
    >
      <Field label={t("apiKeyValue")} name="key" value={value} onChange={setValue} secret />
      <div className="fd-form-actions">
        <button type="submit" className="fd-btn fd-btn-primary">
          {t("save")}
        </button>
        {cred && (
          <button type="button" className="fd-btn" onClick={() => (credentials.update(name, null), setValue(""), setNote(""))}>
            {t("clear")}
          </button>
        )}
        <span role="status" className="fd-note">
          {note}
        </span>
      </div>
    </form>
  );
}

function ClientCredentials({ name, scheme }: { name: string; scheme: SecurityScheme }) {
  const { doc, credentials, t, preset, origin } = useDoc();
  const flow = scheme.flows!.clientCredentials!;
  const cred = useCredentials(credentials)[name];
  const saved = cred?.type === "oauth2" ? cred : undefined;
  const [id, setId] = useState(saved?.clientId ?? preset?.oauth2?.clientId ?? "");
  const [secret, setSecret] = useState(saved?.clientSecret ?? "");
  const [scopes, setScopes] = useState<string[]>(saved?.scopes ?? preset?.oauth2?.scopes ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tokenUrl = absoluteUrl(preset?.oauth2?.tokenUrl ?? flow.tokenUrl ?? "", serverUrlOf(doc, undefined, origin));
  const get = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetchToken({ tokenUrl, clientId: id.trim(), clientSecret: secret, scopes, extra: preset?.oauth2?.extraParams });
      credentials.update(name, { type: "oauth2", clientId: id.trim(), clientSecret: secret, scopes, accessToken: r.accessToken, expiresAt: r.expiresAt });
    } catch (err) {
      setError((err as Error).message || t("tokenFailed"));
    } finally {
      setBusy(false);
    }
  };
  const live = saved?.accessToken && !expired(saved);
  const minutes = saved?.expiresAt ? Math.max(0, Math.round((saved.expiresAt - Date.now()) / 60000)) : undefined;
  return (
    <form onSubmit={get} className="fd-form">
      <Field label={t("clientId")} name="client_id" value={id} onChange={setId} />
      <Field label={t("clientSecret")} name="client_secret" value={secret} onChange={setSecret} secret />
      {Object.keys(flow.scopes ?? {}).length > 0 && (
        <fieldset className="fd-scopes">
          <legend>{t("scopes")}</legend>
          {Object.entries(flow.scopes!).map(([scope, description]) => (
            <label key={scope}>
              <input type="checkbox" checked={scopes.includes(scope)} onChange={(e) => setScopes(e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope))} />
              <code>{scope}</code>
              {description && <span>{description}</span>}
            </label>
          ))}
        </fieldset>
      )}
      <p className="fd-note">{t("tokenFrom", { url: tokenUrl })}</p>
      <div className="fd-form-actions">
        <button type="submit" className="fd-btn fd-btn-primary" disabled={busy || !id.trim() || !secret}>
          {busy ? t("gettingToken") : t("getToken")}
        </button>
        {cred && (
          <button type="button" className="fd-btn" onClick={() => (credentials.update(name, null), setId(""), setSecret(""), setScopes([]), setError(""))}>
            {t("clear")}
          </button>
        )}
        <span role="status" className="fd-note">
          {live ? t("tokenActive", { n: minutes ?? 0 }) : saved?.accessToken ? t("tokenExpired") : ""}
        </span>
      </div>
      {error && (
        <p className="fd-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** A token pasted in for a flow the page can't run itself (authorization code, OpenID Connect). */
function PasteToken({ name }: { name: string }) {
  const { credentials, t } = useDoc();
  const cred = useCredentials(credentials)[name];
  const [token, setToken] = useState(cred?.type === "oauth2" ? (cred.accessToken ?? "") : "");
  return (
    <form
      className="fd-form"
      onSubmit={(e) => {
        e.preventDefault();
        credentials.update(name, { type: "oauth2", accessToken: token.trim() });
      }}
    >
      <Field label={t("accessToken")} name="access_token" value={token} onChange={setToken} secret />
      <div className="fd-form-actions">
        <button type="submit" className="fd-btn fd-btn-primary">
          {t("save")}
        </button>
        {cred && (
          <button type="button" className="fd-btn" onClick={() => (credentials.update(name, null), setToken(""))}>
            {t("clear")}
          </button>
        )}
      </div>
    </form>
  );
}

export default function AuthorizeDialog({ onClose }: { onClose: () => void }) {
  const { model, t, credentials } = useDoc();
  const ref = useRef<HTMLDialogElement>(null);
  useCredentials(credentials);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="fd-dialog" aria-labelledby="fd-auth-title" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <div className="fd-dialog-head">
        <h2 id="fd-auth-title">{t("authorize")}</h2>
        <button type="button" className="fd-btn fd-btn-ghost" onClick={() => ref.current?.close()} aria-label={t("close")}>
          {t("close")}
        </button>
      </div>
      <p className="fd-note">{t("credentialsNote")}</p>
      {model.schemes.length === 0 && <p>{t("noSchemes")}</p>}
      {model.schemes.map(([name, scheme]) => (
        <section className="fd-scheme" key={name}>
          <h3>
            <code>{name}</code>
          </h3>
          <Markdown text={scheme.description} headings={4} />
          {scheme.type === "apiKey" ? (
            <ApiKey name={name} />
          ) : scheme.type === "http" ? (
            <Bearer name={name} scheme={scheme} />
          ) : scheme.type === "oauth2" && scheme.flows?.clientCredentials ? (
            <ClientCredentials name={name} scheme={scheme} />
          ) : scheme.type === "oauth2" || scheme.type === "openIdConnect" ? (
            <PasteToken name={name} />
          ) : null}
        </section>
      ))}
    </dialog>
  );
}
