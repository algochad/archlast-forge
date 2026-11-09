import { Link, Outlet } from "@archlast/forge-framework";
import type { ReactNode } from "react";

export const islands = true;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
      </head>
      <body>{children}</body>
    </html>
  );
}

export default function Root() {
  return (
    <>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link>
      </nav>
      <Outlet />
    </>
  );
}
