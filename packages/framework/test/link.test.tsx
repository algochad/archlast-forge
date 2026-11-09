import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Link as RouterLink, NavLink as RouterNavLink, createMemoryRouter, createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { Link, NavLink } from "../src/link";

/** The attributes of every tag in a fixed order: what a browser sees does not depend on it. */
const normal = (html: string) => html.replace(/<(\w+)((?:\s[^>]*?)?)(\/?)>/g, (_, tag, attrs, close) => `<${tag}${(attrs.match(/\s[^\s=]+(?:="[^"]*")?/g) ?? []).sort().join("")}${close}>`);

/** The same element tree rendered at `url` with React Router's links and with the framework's. */
async function both(url: string, tree: (L: { Link: typeof Link; NavLink: typeof NavLink }) => React.ReactNode) {
  const render = async (L: { Link: typeof Link; NavLink: typeof NavLink }) => {
    const routes = [{ path: "*", Component: () => <nav>{tree(L)}</nav> }];
    const handler = createStaticHandler(routes);
    const ctx = (await handler.query(new Request(`http://x${url}`))) as Awaited<ReturnType<typeof handler.query>> & object;
    return renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, ctx as never)} context={ctx as never} hydrate={false} />);
  };
  return [await render({ Link: RouterLink as typeof Link, NavLink: RouterNavLink as typeof NavLink }), await render({ Link, NavLink })] as const;
}

describe("Link and NavLink on the server print what React Router's print", () => {
  test("plain paths, with classes, ids and children", async () => {
    const [a, b] = await both("/x", ({ Link, NavLink }) => (
      <>
        <Link to="/">Home</Link>
        <Link to="/products" className="btn" id="p" title="t" data-x="1">
          Products
        </Link>
        <Link to="/a/b/c" aria-label="deep">
          <b>deep</b>
        </Link>
      </>
    ));
    expect(normal(b)).toBe(normal(a));
  });

  test("NavLink: active on the path, below it, never with `end`, with a function className, with a trailing slash and other case", async () => {
    for (const url of ["/", "/products", "/products/42", "/Products/x", "/other", "/productsmore"]) {
      const [a, b] = await both(url, ({ NavLink }) => (
        <>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/">Root</NavLink>
          <NavLink to="/products" className="nav">
            Products
          </NavLink>
          <NavLink to="/products/" className={({ isActive }) => (isActive ? "on" : "off")}>
            Slash
          </NavLink>
          <NavLink to="/products" end style={{ color: "red" }}>
            Exact
          </NavLink>
        </>
      ));
      expect([url, normal(b)]).toEqual([url, normal(a)]);
    }
  });

  test("anything beyond a plain path is React Router's own", async () => {
    const [a, b] = await both("/x", ({ Link, NavLink }) => (
      <>
        <Link to="/a?x=1#h">Query</Link>
        <Link to="../up">Relative</Link>
        <Link to="/z" replace>
          Replace
        </Link>
        <Link to="/z" target="_blank">
          Blank
        </Link>
        <NavLink to="/m" className={({ isActive }) => String(isActive)}>
          {({ isActive }) => (isActive ? "yes" : "no")}
        </NavLink>
        <Link to={{ pathname: "/obj" }}>Object</Link>
      </>
    ));
    expect(normal(b)).toBe(normal(a));
  });
});
