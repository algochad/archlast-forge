// The one place the page keeps what the visitor enters to call the API: a bearer token, an API key, an OAuth2 client and the token fetched
// for it. It lives in sessionStorage (or in memory only, `credentials: "memory"`), is shared with the request builder, and goes nowhere but
// the API's own token endpoint and the builder. Code samples never read it: they show placeholders.
import { useSyncExternalStore } from "react";
import type { ExplorerCredentials } from "./contract";

const EMPTY: ExplorerCredentials = {};

export class CredentialStore {
  private value: ExplorerCredentials = EMPTY;
  private loaded = false;
  private listeners = new Set<() => void>();

  constructor(
    private readonly mode: "session" | "memory",
    private readonly key: string,
  ) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.mode !== "session") return;
    try {
      const raw = sessionStorage.getItem(this.key);
      if (raw) this.value = JSON.parse(raw) as ExplorerCredentials;
    } catch {
      // No storage here (a private window, a server): memory only.
    }
  }

  get = (): ExplorerCredentials => {
    this.load();
    return this.value;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Replaces everything. Does nothing when nothing changed, so the request builder echoing it back doesn't loop. */
  set(next: ExplorerCredentials) {
    this.load();
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = Object.keys(next).length ? next : EMPTY;
    if (this.mode === "session") {
      try {
        if (Object.keys(this.value).length) sessionStorage.setItem(this.key, JSON.stringify(this.value));
        else sessionStorage.removeItem(this.key);
      } catch {
        // Kept in memory.
      }
    }
    for (const l of this.listeners) l();
  }

  /** Sets one scheme's credential, or removes it with null. */
  update(scheme: string, credential: ExplorerCredentials[string] | null) {
    const next = { ...this.get() };
    if (credential) next[scheme] = credential;
    else delete next[scheme];
    this.set(next);
  }
}

export const useCredentials = (store: CredentialStore) => useSyncExternalStore(store.subscribe, store.get, () => EMPTY);

/** The form-urlencoded form of a client id or secret, which RFC 6749 asks for before they are joined for Basic. */
const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

export interface TokenRequest {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** More form fields, such as `resource` (RFC 8707) or `audience`. */
  extra?: Record<string, string>;
}

/**
 * Asks the token endpoint for a client-credentials token. The client authenticates with HTTP Basic first (client_secret_basic), and in the
 * form body (client_secret_post) when the server refuses that.
 */
export async function fetchToken(r: TokenRequest, fetcher: typeof fetch = fetch): Promise<{ accessToken: string; expiresAt: number }> {
  const send = (post: boolean) => {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (r.scopes.length) form.set("scope", r.scopes.join(" "));
    for (const [k, v] of Object.entries(r.extra ?? {})) form.set(k, v);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (post) {
      form.set("client_id", r.clientId);
      form.set("client_secret", r.clientSecret);
    } else headers.authorization = `Basic ${btoa(`${formEncode(r.clientId)}:${formEncode(r.clientSecret)}`)}`;
    return fetcher(r.tokenUrl, { method: "POST", headers, body: form, credentials: "omit", cache: "no-store" });
  };
  let res = await send(false);
  if (res.status === 401 || res.status === 400) {
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 || body.error === "invalid_client") res = await send(true);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error_description ?? body.error ?? `${res.status} ${res.statusText}`.trim());
  return { accessToken: body.access_token, expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000 };
}

/** The token URL as the browser can call it: absolute, or a path on the API's server (`/oauth/token` is at that server's origin). */
export const absoluteUrl = (url: string, server: string) => {
  try {
    return new URL(url, new URL(server).origin).href;
  } catch {
    return url;
  }
};
