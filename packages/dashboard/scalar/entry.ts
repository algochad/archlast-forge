// The engine's request builder ("Try it"). Ours, not a patch: scripts/update-scalar.ts copies this file into the patched Scalar checkout
// (packages/api-client/forge-explorer/) and bundles it, with Scalar's own API client modal, into the one script
// packages/dashboard/vendor/scalar/explorer.js. The script defines `window.ForgeExplorer`, as src/api-docs/contract.ts says, and loads
// explorer.css from beside itself.
//
// Everything the contract promises is configuration of upstream, not forked behaviour, except what patches/ says (read their headers):
//   theme         -> Scalar's --scalar-* custom properties, set on the element that holds the builder, and the light-mode / dark-mode class
//   auth          -> the document's OAuth2 flows (token URL, extra token parameters, client id, scopes) and `preferredSecurityScheme`
//   credentials   -> Scalar's auth store (setAuthSecrets), read back through the store's change hook for `onCredentials`
//   codeSamples   -> Scalar's `hiddenClients` (every client that is not one of the languages asked for)
//   strings       -> Scalar's localization overrides; keys are dot paths such as "apiClient.requestBlock.requestBody"
import { createApiClientModal } from "@/v2/features/modal/helpers/create-api-client-modal";
import type { ApiClientModal } from "@/v2/features/modal/helpers/create-api-client-modal";
import type { ApiClientOptions } from "@/v2/types/options";
import { AVAILABLE_CLIENTS } from "@scalar/types/snippetz";
import { createWorkspaceStore } from "@scalar/workspace-store/client";
import type { WorkspaceStore } from "@scalar/workspace-store/client";
import { createWorkspaceEventBus } from "@scalar/workspace-store/events";
import { watch } from "vue";
import "@/style.css";
import type { CodeSampleLanguage, ExplorerCredentials, ExplorerInstance, ExplorerOptions, ForgeExplorerGlobal } from "../src/api-docs/contract";

/** Set by the build: "scalar <upstream release> + <n> patches". */
declare const FORGE_EXPLORER_VERSION: string;

type Json = Record<string, any>;

const DOCUMENT = "default";

/** The URL this script was loaded from (known while it runs the first time; else the script tag that looks like it): the stylesheet is its sibling. */
const SCRIPT_URL = (() => {
  if (typeof document === "undefined") return "";
  if (document.currentScript instanceof HTMLScriptElement && document.currentScript.src) return document.currentScript.src;
  return [...document.scripts].reverse().find((script) => /\/explorer\.js(?:[?#]|$)/.test(script.src))?.src ?? "";
})();

let styles: Promise<void> | undefined;
/** Loads explorer.css once, from next to this script, and resolves when it applies (or failed: an unstyled builder still works). */
function loadStyles(): Promise<void> {
  styles ??= new Promise((done) => {
    const href = SCRIPT_URL.replace(/\.js(?=$|[?#])/, ".css");
    if (!SCRIPT_URL || href === SCRIPT_URL) return done();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => done());
    link.addEventListener("error", () => done());
    document.head.append(link);
  });
  return styles;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Theme

type Theme = ExplorerOptions["theme"];

const mix = (a: string, b: string, percentOfB: number) => `color-mix(in srgb, ${a}, ${b} ${percentOfB}%)`;

/** The page's tokens as Scalar's custom properties. Anything Scalar derives from these (the sidebar, hover states) follows by itself. */
function themeVariables(t: Theme): Record<string, string> {
  return {
    "--scalar-background-1": t.background,
    "--scalar-background-2": t.surface,
    "--scalar-background-3": mix(t.surface, t.text, 9),
    "--scalar-background-accent": mix(t.accent, "transparent", 86),
    "--scalar-color-1": t.text,
    "--scalar-color-2": t.muted,
    "--scalar-color-3": mix(t.muted, t.background, 45),
    "--scalar-color-accent": t.accent,
    "--scalar-border-color": t.border,
    "--scalar-link-color": t.accent,
    "--scalar-link-color-hover": mix(t.accent, t.text, 20),
    "--scalar-button-1": t.text,
    "--scalar-button-1-hover": mix(t.text, t.background, 20),
    "--scalar-button-1-color": t.background,
    "--scalar-font": t.font,
    "--scalar-font-code": t.monoFont,
    // The radius scale is derived from --scalar-radius on :root, where it was resolved, so each step is stated again here.
    "--scalar-radius": t.radius,
    "--scalar-radius-md": "min(var(--scalar-radius), var(--scalar-radius-max))",
    "--scalar-radius-lg": "min(calc(var(--scalar-radius) * 2), var(--scalar-radius-max))",
    "--scalar-radius-xl": "min(calc(var(--scalar-radius) * 8 / 3), var(--scalar-radius-max))",
    "--scalar-radius-2xl": "min(calc(var(--scalar-radius) * 4), var(--scalar-radius-max))",
    "--scalar-radius-3xl": "min(calc(var(--scalar-radius) * 16 / 3), var(--scalar-radius-max))",
    "--scalar-radius-full": "calc(var(--scalar-radius) * 9999)",
  };
}

function paint(el: HTMLElement, t: Theme) {
  el.classList.toggle("dark-mode", t.mode === "dark");
  el.classList.toggle("light-mode", t.mode !== "dark");
  for (const [name, value] of Object.entries(themeVariables(t))) el.style.setProperty(name, value);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The document and the auth preset

/** `url` resolved like a browser resolves a link on the API's server (which may itself be relative to the page): "/oauth/token" is that server's origin. */
const resolveOnServer = (url: string, server: string, pageOrigin: string): string => new URL(url, new URL(server || "/", pageOrigin)).href;

/**
 * A copy of the page's document, ready for the builder: the page's origin as the server when the document names none, and the app's
 * OAuth2 preset written into the flows (upstream reads `x-scalar-security-body` for the token request and `x-scalar-client-id` for the field).
 */
function prepareDocument(options: ExplorerOptions): Json {
  const doc = structuredClone(options.document) as Json;
  if (!Array.isArray(doc.servers) || doc.servers.length === 0) doc.servers = [{ url: options.baseServerUrl }];
  const schemes: Json = doc.components?.securitySchemes ?? {};
  const preset = options.auth?.oauth2;
  const scopes = new Map<string, Set<string>>();
  for (const [name, credential] of Object.entries(options.credentials ?? {})) {
    if (credential.type === "oauth2" && credential.scopes?.length) scopes.set(name, new Set(credential.scopes));
  }
  for (const [name, scheme] of Object.entries<Json>(schemes)) {
    if (scheme?.type !== "oauth2" || !scheme.flows) continue;
    const forThis = !options.auth?.preferredScheme || options.auth.preferredScheme === name;
    for (const flow of Object.values<Json>(scheme.flows)) {
      if (forThis && preset) {
        if (preset.tokenUrl && "tokenUrl" in flow) flow.tokenUrl = resolveOnServer(preset.tokenUrl, doc.servers[0]?.url ?? "", options.baseServerUrl);
        if (preset.extraParams && Object.keys(preset.extraParams).length) flow["x-scalar-security-body"] = { ...flow["x-scalar-security-body"], ...preset.extraParams };
        if (preset.clientId) flow["x-scalar-client-id"] ??= preset.clientId;
      }
      const wanted = new Set([...(forThis ? (preset?.scopes ?? []) : []), ...(scopes.get(name) ?? [])]);
      if (wanted.size) {
        const declared = Object.keys(flow.scopes ?? {});
        flow.selectedScopes = [...wanted].filter((scope) => declared.length === 0 || declared.includes(scope));
      }
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Credentials: the page's shape <-> Scalar's auth store

const FLOW_ORDER = ["clientCredentials", "authorizationCode", "password", "implicit", "deviceAuthorization"] as const;

const nonEmpty = <T extends Record<string, unknown>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))) as T;

/** What the auth store holds, as the page's credentials. Schemes with nothing entered are left out. `expiry` knows when tokens fetched here end. */
function readCredentials(store: WorkspaceStore, expiry: Map<string, TokenGrant>): ExplorerCredentials {
  const auth = store.auth.export()[DOCUMENT];
  const out: ExplorerCredentials = {};
  if (!auth) return out;
  const selected = [auth.selected.document, ...Object.values(auth.selected.path ?? {}).flatMap((methods) => Object.values(methods ?? {}))];
  for (const [name, secrets] of Object.entries<Json>(auth.secrets)) {
    if (secrets.type === "http") {
      const entry = nonEmpty({ type: "http" as const, token: secrets["x-scalar-secret-token"], username: secrets["x-scalar-secret-username"], password: secrets["x-scalar-secret-password"] });
      if (Object.keys(entry).length > 1) out[name] = entry;
    } else if (secrets.type === "apiKey") {
      if (secrets["x-scalar-secret-token"]) out[name] = { type: "apiKey", value: secrets["x-scalar-secret-token"] };
    } else if (secrets.type === "oauth2") {
      const flow = FLOW_ORDER.map((key) => secrets[key] as Json | undefined).find((f) => f && (f["x-scalar-secret-client-id"] || f["x-scalar-secret-token"] || f["x-scalar-secret-client-secret"]));
      if (!flow) continue;
      const scopes = [...new Set(selected.flatMap((s) => s?.selectedSchemes ?? []).flatMap((requirement: Json) => (requirement[name] as string[] | undefined) ?? []))];
      out[name] = nonEmpty({
        type: "oauth2" as const,
        clientId: flow["x-scalar-secret-client-id"],
        clientSecret: flow["x-scalar-secret-client-secret"],
        scopes,
        accessToken: flow["x-scalar-secret-token"],
        expiresAt: expiry.get(flow["x-scalar-secret-token"])?.expiresAt,
      });
    }
  }
  return out;
}

/** Puts the page's credentials into the auth store (replacing what the store held for those schemes). */
function writeCredentials(store: WorkspaceStore, schemes: Json, credentials: ExplorerCredentials, expiry: Map<string, TokenGrant>) {
  for (const [name, credential] of Object.entries(credentials)) {
    if (credential.type === "http") {
      store.auth.setAuthSecrets(DOCUMENT, name, { type: "http", "x-scalar-secret-token": credential.token ?? "", "x-scalar-secret-username": credential.username ?? "", "x-scalar-secret-password": credential.password ?? "" });
    } else if (credential.type === "apiKey") {
      store.auth.setAuthSecrets(DOCUMENT, name, { type: "apiKey", "x-scalar-secret-token": credential.value });
    } else if (credential.type === "oauth2") {
      const flows = Object.keys(schemes[name]?.flows ?? {});
      const flow = FLOW_ORDER.find((key) => flows.includes(key)) ?? "clientCredentials";
      const previous = (store.auth.getAuthSecrets(DOCUMENT, name) as Json | undefined)?.[flow] ?? {};
      // A token the page knows has ended is not worth sending.
      const live = credential.accessToken && !(credential.expiresAt && credential.expiresAt <= Date.now());
      if (live && credential.expiresAt) expiry.set(credential.accessToken!, { expiresAt: credential.expiresAt });
      store.auth.setAuthSecrets(DOCUMENT, name, {
        type: "oauth2",
        [flow]: {
          ...previous,
          "x-scalar-secret-client-id": credential.clientId ?? "",
          "x-scalar-secret-client-secret": credential.clientSecret ?? "",
          "x-scalar-secret-token": live ? credential.accessToken : "",
        },
      } as never);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Token lifetimes. Upstream keeps the access token but not when it ends, and re-fetching a client-credentials token is a button the visitor
// presses again. Every request the builder sends goes through `customFetch`, so this sees the token response (`expires_in`) and, when a later
// request carries a token that has ended, asks the token endpoint again with the same request before sending it.

interface TokenGrant {
  expiresAt?: number;
  /** The token request, to be repeated (client credentials only: nothing the visitor has to be asked for). */
  replay?: { url: string; init: RequestInit };
}

type Input = string | URL | Request;
const headersOf = (input: Input, init?: RequestInit) => new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

function tokenAwareFetch(expiry: Map<string, TokenGrant>, onRefreshed: (before: string, after: string) => void): (input: Input, init?: RequestInit) => Promise<Response> {
  const grant = async (url: string, init: RequestInit): Promise<{ response: Response; token?: string }> => {
    const response = await fetch(url, init);
    const body = await response
      .clone()
      .json()
      .catch(() => undefined);
    const token = typeof body?.access_token === "string" ? body.access_token : undefined;
    if (token) expiry.set(token, { expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined, replay: { url, init } });
    return { response, token };
  };
  return async (input, init) => {
    const body = init?.body;
    if (typeof input === "string" && body instanceof URLSearchParams && body.has("grant_type")) {
      // Only client credentials may be asked for again without the visitor.
      if (body.get("grant_type") !== "client_credentials") return fetch(input, init);
      return (await grant(input, init!)).response;
    }
    const headers = headersOf(input, init);
    const old = /^Bearer (.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
    const known = old ? expiry.get(old) : undefined;
    if (old && known?.replay && known.expiresAt && known.expiresAt - 5000 <= Date.now()) {
      const renewed = await grant(known.replay.url, known.replay.init).catch(() => undefined);
      if (renewed?.token && renewed.response.ok) {
        onRefreshed(old, renewed.token);
        headers.set("authorization", `Bearer ${renewed.token}`);
        return input instanceof Request ? fetch(new Request(input, { headers })) : fetch(input, { ...init, headers });
      }
    }
    return fetch(input, init);
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Code samples and strings

const CLIENT_OF: Record<CodeSampleLanguage, string> = {
  curl: "shell/curl",
  node: "node/fetch",
  python: "python/requests",
  go: "go/native",
  php: "php/curl",
  ruby: "ruby/native",
  java: "java/okhttp",
  csharp: "csharp/httpclient",
};

/** Upstream hides clients rather than listing the ones to show: every client except the languages asked for. */
function hiddenClients(languages: CodeSampleLanguage[] | undefined): string[] {
  if (!languages?.length) return [];
  const shown = new Set(languages.map((language) => CLIENT_OF[language]).filter(Boolean));
  return AVAILABLE_CLIENTS.filter((client) => !shown.has(client));
}

/** `{ "apiClient.requestBlock.requestBody": "Corps" }` as the nested object upstream merges over its English text. */
function nest(strings: Record<string, string> | undefined): Json {
  const out: Json = {};
  for (const [path, text] of Object.entries(strings ?? {})) {
    const keys = path.split(".");
    if (keys.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) continue;
    let at = out;
    for (const key of keys.slice(0, -1)) at = at[key] ??= {};
    at[keys[keys.length - 1]!] = text;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------

function mount(el: HTMLElement, initial: ExplorerOptions): ExplorerInstance {
  let options = initial;
  let destroyed = false;
  let applying = false;
  let skipOnClose = false;
  let lastReported = "";
  const expiry = new Map<string, TokenGrant>();

  const host = document.createElement("div");
  host.className = "forge-explorer";
  el.append(host);

  const eventBus = createWorkspaceEventBus({ debug: false });
  const store = createWorkspaceStore({
    plugins: [
      {
        hooks: {
          onWorkspaceStateChanges(event) {
            if (event.type !== "auth" || applying || !options.onCredentials) return;
            const credentials = readCredentials(store, expiry);
            const text = JSON.stringify(credentials);
            if (text === lastReported) return;
            lastReported = text;
            options.onCredentials(credentials);
          },
        },
      },
    ],
  });

  const clientOptions = (): ApiClientOptions => ({
    baseServerURL: options.baseServerUrl,
    // No hosted client button and no proxy: requests go from the visitor's browser to the API itself.
    hideClientButton: true,
    customFetch: tokenAwareFetch(expiry, replaceToken),
    hiddenClients: hiddenClients(options.codeSamples),
    localization: { translations: nest(options.strings) },
    authentication: { preferredSecurityScheme: options.auth?.preferredScheme ?? firstCredentialScheme() },
  });
  const firstCredentialScheme = () => Object.keys(options.credentials ?? {})[0];
  /** A client-credentials token that was renewed: the store holds the new one where it held the old one. */
  const replaceToken = (before: string, after: string) => {
    for (const [scheme, secrets] of Object.entries<Json>(store.auth.export()[DOCUMENT]?.secrets ?? {})) {
      const flow = secrets.type === "oauth2" ? (secrets.clientCredentials as Json | undefined) : undefined;
      if (flow?.["x-scalar-secret-token"] === before) store.auth.setAuthSecrets(DOCUMENT, scheme, { type: "oauth2", clientCredentials: { ...flow, "x-scalar-secret-token": after } } as never);
    }
  };

  const load = async () => {
    const doc = prepareDocument(options);
    applying = true;
    try {
      if (store.workspace.documents[DOCUMENT]) await store.replaceDocument(DOCUMENT, doc);
      else await store.addDocument({ name: DOCUMENT, document: doc });
      if (options.credentials) writeCredentials(store, doc.components?.securitySchemes ?? {}, options.credentials, expiry);
      lastReported = JSON.stringify(readCredentials(store, expiry));
    } finally {
      applying = false;
    }
    if (options.codeSamples?.length) store.update("x-scalar-default-client", CLIENT_OF[options.codeSamples[0]!]);
  };

  paint(host, options.theme);
  let ready: Promise<unknown> = Promise.all([loadStyles(), load()]);
  let modal: ApiClientModal | undefined;
  const instance: ExplorerInstance = {
    open(target) {
      void ready.then(() => {
        if (destroyed) return;
        modal ??= create();
        modal.open({ path: target.path, method: target.method.toLowerCase() });
      });
    },
    close() {
      // The page asked: it knows, so onClose (the visitor leaving) is not called for it.
      if (modal?.modalState.open) skipOnClose = true;
      modal?.modalState.hide();
    },
    update(next) {
      options = { ...options, ...next };
      paint(host, options.theme);
      modal?.updateOptions(clientOptions(), true);
      if (next.document || next.auth || next.credentials || next.baseServerUrl) ready = ready.then(load);
    },
    destroy() {
      destroyed = true;
      stop?.();
      modal?.app.unmount();
      host.remove();
    },
  };

  let stop: (() => void) | undefined;
  const create = (): ApiClientModal => {
    const created = createApiClientModal({ el: host, eventBus, workspaceStore: store, options: clientOptions() });
    // Scalar closes the builder by hiding it; the page learns about it here.
    stop = watch(
      () => created.modalState.open,
      (open, was) => {
        if (!was || open) return;
        if (skipOnClose) skipOnClose = false;
        else instance.onClose?.();
      },
    );
    return created;
  };

  return instance;
}

const api: ForgeExplorerGlobal = { version: FORGE_EXPLORER_VERSION, mount };
window.ForgeExplorer = api;
