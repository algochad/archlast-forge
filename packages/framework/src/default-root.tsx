import { isRouteErrorResponse, Outlet, useRouteError } from "react-router";
import type { ReactNode } from "react";
import { useDev } from "./providers";

/** The document used when `app/root.tsx` doesn't export its own `Layout`. */
export function DefaultLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}

const CARD = {
  box: { fontFamily: "system-ui, sans-serif", maxWidth: 560, margin: "12vh auto", padding: "0 24px", lineHeight: 1.5 },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 13, whiteSpace: "pre-wrap" as const, background: "rgba(127,127,127,.15)", padding: 12, borderRadius: 8, overflow: "auto" },
};

/** Shown for routes that don't export an `ErrorBoundary`: 404s, thrown responses and errors in loaders or components. */
export function DefaultErrorBoundary() {
  const error = useRouteError();
  const dev = useDev();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const title = status === 404 ? "Page not found" : status === 401 || status === 403 ? "Not allowed" : "Something went wrong";
  const detail = isRouteErrorResponse(error) ? (typeof error.data === "string" ? error.data : "") : error instanceof Error ? (dev ? (error.stack ?? error.message) : error.message) : "";
  return (
    <main style={CARD.box}>
      <title>{`${status} · ${title}`}</title>
      <h1 style={{ marginBottom: 4 }}>{status}</h1>
      <p style={{ marginTop: 0, fontSize: 18 }}>{title}</p>
      {detail && <pre style={CARD.code}>{detail}</pre>}
      <p>
        <a href="/">Back to the start</a>
      </p>
    </main>
  );
}

export { Outlet };
