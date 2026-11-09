// The archlast-forge side of the comparison: a project made from the framework starter, with the same two pages as the other apps, built for production and served by
// the real engine on :3400. KEEP=1 asks the home route to be kept by the engine (`handle.cache`, what the starters ship); ISLANDS=0 renders and hydrates whole pages.
//   bun benchmarks/fullstack/archlast/server.ts           prints "ready <port>" and serves until killed
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codegen } from "../../../packages/cli/src/codegen";
import { buildApp } from "../../../packages/framework/src/build";
import { createApp } from "../../../packages/framework/src/server";
import { startServer } from "../../../packages/runtime/src/server/server";
import { templateProject } from "../../../packages/framework/test/template";

const keep = process.env.KEEP === "1";
const islands = process.env.ISLANDS !== "0";
const dir = templateProject("bench-fullstack", "framework", []);
rmSync(join(dir, "app", "routes"), { recursive: true, force: true });
mkdirSync(join(dir, "app", "routes"), { recursive: true });
rmSync(join(dir, "app", "components"), { recursive: true, force: true });
const shared = join(import.meta.dir, "..", "shared", "data.ts");
writeFileSync(join(dir, "app", "data.ts"), (await Bun.file(shared).text()));

writeFileSync(
  join(dir, "app", "root.tsx"),
  `import { Link, NavLink, Outlet } from "@archlast/forge-framework";
import type { ReactNode } from "react";
${islands ? "export const islands = true;" : ""}

export function Layout({ children }: { children: ReactNode }) {
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

export default function Root() {
  return (
    <>
      <header>
        <Link to="/">Bench</Link>
        <nav>
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/products">Products</NavLink>
        </nav>
      </header>
      <Outlet />
      <footer>Built for the benchmark</footer>
    </>
  );
}
`,
);
writeFileSync(
  join(dir, "app", "routes", "index.tsx"),
  `${keep ? "export const handle = { cache: { ttl: 60 } };\n" : ""}
const FEATURES = [
  ["Rendered on the server", "Every page arrives as HTML with its data already in it."],
  ["Typed from end to end", "Loaders, actions and components share their types."],
  ["One deploy", "Pages, API and assets ship together."],
];

export default function Home() {
  return (
    <main>
      <title>Home</title>
      <h1>Realtime. Full-stack. One deploy.</h1>
      <p>Server-rendered React with a typed backend.</p>
      <ul>
        {FEATURES.map(([title, text]) => (
          <li key={title}>
            <h3>{title}</h3>
            <p>{text}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
`,
);
writeFileSync(
  join(dir, "app", "routes", "products.tsx"),
  `import { useLoaderData } from "@archlast/forge-framework";
import { formatDate, formatMoney, products } from "../data";

export async function loader() {
  return { rows: await Promise.resolve(products()) };
}

export default function Products() {
  const { rows } = useLoaderData<typeof loader>();
  return (
    <main>
      <title>Products</title>
      <h1>Products</h1>
      <table>
        <thead>
          <tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock</th><th>Added</th></tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.sku}</td>
              <td>{p.name}</td>
              <td>{formatMoney(p.priceCents)}</td>
              <td>{p.stock}</td>
              <td>{formatDate(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
`,
);
await codegen(join(dir, "forge"));
await buildApp({ root: dir, dev: false });
const srv = await startServer({
  forgeDir: join(dir, "forge"),
  dev: false,
  env: { ...process.env, PORT: "3400", DATA_DIR: join(dir, "data"), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000000", LOG_LEVEL: "warn" },
  app: await createApp({ root: dir, dev: false, log: () => {} }),
});
console.log("ready", srv.url);
setInterval(() => {}, 1e6);
if (process.env.EXIT_AFTER) setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER) * 1000);
