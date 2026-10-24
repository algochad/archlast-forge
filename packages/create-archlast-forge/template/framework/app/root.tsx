import { isRouteErrorResponse, Link, NavLink, Outlet, useNavigate, useRouteError, useViewer } from "@archlast-forge/framework";
import { useAuth } from "@archlast-forge/react";
import type { ReactNode } from "react";
import "./styles.css";

/** The HTML document around every page, including error pages. */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>{children}</body>
    </html>
  );
}

/** The header and footer around a page, and around the error page, so there is always a way back. */
function Chrome({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const auth = useAuth();
  const navigate = useNavigate();

  async function signOut() {
    await auth.signOut();
    await navigate("/");
  }

  return (
    <>
      <header className="site-header">
        <div className="container">
          <Link to="/" className="brand">
            <img src="/favicon.svg" alt="" />
            __NAME__
          </Link>
          <nav className="site-nav" aria-label="Main">
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/chat">Chat</NavLink>
          </nav>
          {viewer ? (
            <div className="who">
              <span className="avatar" aria-hidden>{viewer.name.slice(0, 1).toUpperCase()}</span>
              <span>{viewer.name}</span>
              <button className="btn small" onClick={signOut}>Sign out</button>
            </div>
          ) : (
            <Link className="btn small primary" to="/sign-in">Sign in</Link>
          )}
        </div>
      </header>
      <div className="page">{children}</div>
      <footer className="site-footer">
        <div className="container">Built with archlast-forge · edit <code>app/root.tsx</code> to change this page</div>
      </footer>
    </>
  );
}

export default function Root() {
  return (
    <Chrome>
      <Outlet />
    </Chrome>
  );
}

/** Shown for 404s and for errors thrown by loaders and components. */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = status === 404 ? "That page doesn't exist." : isRouteErrorResponse(error) ? String(error.data || error.statusText) : error instanceof Error ? error.message : "Something went wrong.";
  return (
    <Chrome>
      <main className="container problem">
        <title>{status === 404 ? "Page not found" : "Something went wrong"}</title>
        <p className="code">{status}</p>
        <h1>{status === 404 ? "Page not found" : "Something went wrong"}</h1>
        <p className="lead">{message}</p>
        <p>
          <Link className="btn primary" to="/">Go home</Link>
        </p>
      </main>
    </Chrome>
  );
}
