import { isRouteErrorResponse, Link, NavLink, Outlet, useNavigate, useNonce, useRouteError, useViewer } from "@archlast/forge-framework";
import { useAuth } from "@archlast/forge-react";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import "./styles.css";

// Runs before the first paint, so the saved theme (or the system's) does not flash the other one. It carries the page's nonce: the engine's
// Content-Security-Policy runs an inline script only with it.
const THEME = `try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

/** The HTML document around every page, including error pages. */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body className="flex min-h-dvh flex-col">{children}</body>
    </html>
  );
}

const navLink = ({ isActive }: { isActive: boolean }) => cn(buttonVariants({ variant: "ghost", size: "sm" }), isActive ? "bg-muted text-foreground" : "text-muted-foreground");

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
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="size-6" />
            __NAME__
          </Link>
          <nav className="flex flex-1 gap-1" aria-label="Main">
            <NavLink to="/" end className={navLink}>Home</NavLink>
            <NavLink to="/chat" className={navLink}>Chat</NavLink>
          </nav>
          <ThemeToggle />
          {viewer ? (
            <div className="who flex items-center gap-2 text-sm text-muted-foreground">
              <Avatar size="sm" aria-hidden>
                <AvatarFallback>{viewer.name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span>{viewer.name}</span>
              <Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>
            </div>
          ) : (
            <Link to="/sign-in" className={buttonVariants({ size: "sm" })}>Sign in</Link>
          )}
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t py-5 text-sm text-muted-foreground">
        <div className="mx-auto w-full max-w-5xl px-4">
          Built with archlast-forge · edit <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">app/root.tsx</code> to change this page
        </div>
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
      <main className="mx-auto flex w-full max-w-5xl flex-col items-center gap-4 px-4 py-24 text-center">
        <title>{status === 404 ? "Page not found" : "Something went wrong"}</title>
        <p className="text-7xl font-extrabold text-primary">{status}</p>
        <h1 className="text-3xl font-bold tracking-tight">{status === 404 ? "Page not found" : "Something went wrong"}</h1>
        <p className="max-w-xl text-lg text-muted-foreground">{message}</p>
        <Link className={buttonVariants()} to="/">Go home</Link>
      </main>
    </Chrome>
  );
}
