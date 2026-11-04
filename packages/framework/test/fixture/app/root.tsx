import { Link, Outlet, useViewer } from "@archlast/forge-framework";
import type { BetterAuthClientPlugin } from "@archlast/forge-client";
import type { ReactNode } from "react";
import "./styles.css";

/** A Better Auth client plugin of the app's own: its action reaches useAuth() on the server render and in the browser. */
export const authPlugins = [{ id: "hello", getActions: () => ({ hello: (name: string) => `hello, ${name}` }) } satisfies BetterAuthClientPlugin];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:," />
      </head>
      <body>{children}</body>
    </html>
  );
}

export default function Root() {
  const viewer = useViewer();
  return (
    <>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link> <Link to="/blog">Blog</Link>
        <span id="who">{viewer ? `Hi ${viewer.name}` : "Signed out"}</span>
      </nav>
      <Outlet />
    </>
  );
}
