import { Link, Outlet, useViewer } from "@archlast/forge-framework";
import type { ReactNode } from "react";
import { UserMenu } from "./_c/user-menu";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
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
        <Link to="/">Home</Link> <Link to="/live">Live</Link> <Link to="/old">Old</Link>
        <span id="who">{viewer ? `Hi ${viewer.name}` : "Signed out"}</span>
        {viewer ? <UserMenu label="menu" /> : <Link to="/sign-in">Sign in</Link>}
      </nav>
      <Outlet />
    </>
  );
}
