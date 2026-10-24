import { Link, Outlet, useViewer } from "@archlast/forge-framework";
import type { ReactNode } from "react";
import "./styles.css";

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
