import { Link, useViewer } from "@archlast/forge-framework";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const FEATURES = [
  ["Rendered on the server", "Every page arrives as HTML with its data already in it, then the browser takes over without a flicker."],
  ["Live by default", "A query in a component stays current. Open the chat in two windows and watch both update."],
  ["One container", <>Pages, API, auth, files and the dashboard ship together. <code className="font-mono text-xs">archlast-forge up</code> starts the lot.</>],
] as const;

export default function Home() {
  const viewer = useViewer();
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-16">
      <title>__NAME__</title>
      <p className="mb-4 text-sm font-semibold tracking-widest text-primary uppercase">archlast-forge</p>
      <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-6xl">Realtime. Full-stack. One deploy.</h1>
      <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
        Server-rendered React, a typed backend and live queries in a single container. Edit <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">app/routes/index.tsx</code> and save: the page reloads by itself.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        {viewer ? (
          <Link className={buttonVariants({ size: "lg" })} to="/chat">Open the chat</Link>
        ) : (
          <Link className={buttonVariants({ size: "lg" })} to="/sign-in">Get started</Link>
        )}
        <a className={buttonVariants({ variant: "outline", size: "lg" })} href="https://github.com/algochad/archlast-forge">Read the docs</a>
      </div>
      <ul className="mt-16 grid gap-4 sm:grid-cols-3">
        {FEATURES.map(([title, text]) => (
          <li key={title}>
            <Card className="h-full">
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{text}</CardDescription>
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}
