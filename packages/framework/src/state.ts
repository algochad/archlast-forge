import type { DehydratedState } from "@tanstack/react-query";
import type { Viewer } from "./context";

/** What the server writes into the page: `window.__FORGE__`. */
export interface PageState {
  dev: boolean;
  /** The instant the server rendered the page, and the time zone it formatted in: the browser's hydrating render uses both (see time.tsx). */
  now: number;
  timeZone: string;
  viewer: Viewer | null;
  queries: DehydratedState;
  hydration: { loaderData: Record<string, unknown>; actionData: Record<string, unknown> | null; errors: Record<string, SerializedError> | null };
}

/** Errors cross the wire as plain data. */
export type SerializedError = { kind: "response"; status: number; statusText: string; data: unknown } | { kind: "error"; message: string; stack?: string };

declare global {
  interface Window {
    __FORGE__?: PageState;
    /** Development only (the dev script defines it): a note on top of the page that doesn't block it. */
    __forgeNotice?: (title: string, message: string) => void;
  }
}

/** The errors React Router renders with, rebuilt from plain data. The server renders with these too, so both sides show the same page. */
export function reviveErrors(errors: PageState["hydration"]["errors"]) {
  if (!errors) return null;
  return Object.fromEntries(
    Object.entries(errors).map(([id, e]) => [
      id,
      e.kind === "response" ? { status: e.status, statusText: e.statusText, internal: false, data: e.data } : Object.assign(new Error(e.message), e.stack ? { stack: e.stack } : {}),
    ]),
  );
}
