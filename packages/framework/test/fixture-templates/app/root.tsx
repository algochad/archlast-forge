import { Link, NavLink, Outlet, useViewer } from "@archlast/forge-framework";
import type { ReactNode } from "react";
import { Menu } from "./_c/menu";

export const islands = true;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:," />
      </head>
      <body className="app" style={{ margin: 0, opacity: 1, lineHeight: 1.5 }}>
        {children}
      </body>
    </html>
  );
}

export default function Root() {
  const viewer = useViewer();
  return (
    <>
      <header>
        <Link to="/" className="brand">
          Fixture
        </Link>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/items" className="tab">
            Items
          </NavLink>
          <NavLink to="/odd">Odd</NavLink>
        </nav>
        <span id="who">{viewer ? `Hi ${viewer.name}` : "Signed out"}</span>
        {viewer ? <Menu name={viewer.name} /> : null}
      </header>
      <Outlet />
      <footer>{viewer ? <small>signed in</small> : null}</footer>
    </>
  );
}
