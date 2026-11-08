import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyApp, formatReport } from "../src/classify";
import { tempDir } from "./helpers";

/** An app directory with the given files under app/. */
function app(files: Record<string, string>): string {
  const root = tempDir();
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, "app", name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}
const tierOf = (r: ReturnType<typeof classifyApp>, name: string) =>
  r.components.find((c) => c.name === name)?.tier;

describe("what each component ships to the browser", () => {
  test("a component that only reads props, loader data and the viewer is a page", () => {
    const r = classifyApp(
      app({
        "routes/index.tsx": `import { useViewer, useLoaderData, Link } from "@archlast/forge-framework";
export const loader = () => ({ n: 1 });
export default function Home({ title }: { title: string }) {
  const viewer = useViewer();
  const data = useLoaderData<typeof loader>();
  return <main><h1>{title}</h1>{viewer ? <Link to="/a">{data.n}</Link> : <a href="/b">x</a>}</main>;
}`,
      }),
    );
    expect(tierOf(r, "Home")).toBe("page");
    expect(r.routes[0]!.tier).toBe("page");
  });

  test("state, effects, handlers, refs and browser globals make an island, and say why", () => {
    const r = classifyApp(
      app({
        "routes/a.tsx": `import { useState } from "react";
export default function A() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }`,
        "routes/b.tsx": `export default function B() { return <input onChange={() => {}} /> }`,
        "routes/c.tsx": `import { useRef } from "react";
export default function C() { const r = useRef(null); return <div ref={r} /> }`,
        "routes/d.tsx": `export default function D() { return <p>{window.innerWidth}</p> }`,
        "routes/e.tsx": `import { useMutation } from "@archlast/forge-react";
export default function E() { const m = useMutation(x); return <p /> }`,
      }),
    );
    for (const n of ["A", "B", "C", "D", "E"])
      expect(tierOf(r, n)).toBe("island");
    expect(r.components.find((c) => c.name === "A")!.reasons).toEqual([
      "calls useState()",
      "has an onClick handler",
    ]);
    expect(r.components.find((c) => c.name === "D")!.reasons).toEqual([
      "reads window",
    ]);
  });

  test("a page that renders an island keeps being a page and lists the island", () => {
    const r = classifyApp(
      app({
        "routes/index.tsx": `import { Counter } from "../_c/counter";
export default function Home() { return <main><h1>hi</h1><Counter start={1} /></main>; }`,
        "_c/counter.tsx": `import { useState } from "react";
export function Counter({ start }: { start: number }) { const [n] = useState(start); return <b>{n}</b>; }`,
      }),
    );
    const home = r.components.find((c) => c.name === "Home")!;
    expect(home.tier).toBe("page");
    expect(home.islands).toEqual(["Counter"]);
  });

  test("a page that hands a function or elements to an island becomes an island", () => {
    const r = classifyApp(
      app({
        "routes/f.tsx": `import { Box } from "../_c/box";
export default function F() { return <Box onDone={() => {}} />; }`,
        "routes/g.tsx": `import { Box } from "../_c/box";
export default function G() { return <Box><p>child</p></Box>; }`,
        "_c/box.tsx": `import { useState } from "react";
export function Box(props: any) { const [o] = useState(false); return <div>{props.children}</div>; }`,
      }),
    );
    expect(tierOf(r, "F")).toBe("island");
    expect(tierOf(r, "G")).toBe("island");
    expect(r.components.find((c) => c.name === "F")!.reasons[0]).toContain(
      "passes a function or elements to Box",
    );
  });

  test("what cannot be read fails closed: unknown packages, members, dynamic components, unresolved imports", () => {
    const r = classifyApp(
      app({
        "routes/h.tsx": `import { Widget } from "some-package";
export default function H() { return <Widget />; }`,
        "routes/i.tsx": `import * as Ui from "some-package";
export default function I() { return <Ui.Thing />; }`,
        "routes/j.tsx": `export default function J({ as }: any) { const C = as; return <C />; }`,
        "routes/k.tsx": `import { Gone } from "../_nope/gone";
export default function K() { return <Gone />; }`,
      }),
    );
    for (const n of ["I", "J"]) expect(tierOf(r, n)).toBe("island");
    // a page that merely contains an unread package component lists it as an island
    expect(r.components.find((c) => c.name === "H")!.islands).toEqual([
      "Widget",
    ]);
    expect(r.components.find((c) => c.name === "K")!.islands).toEqual(["Gone"]);
  });

  test("a class or `this` is a fallback; an action makes the route one", () => {
    const r = classifyApp(
      app({
        "routes/l.tsx": `export default function L() { return <p>{String(this)}</p>; }`,
        "routes/m.tsx": `export const action = async () => null;
export default function M() { return <p /> }`,
      }),
    );
    expect(tierOf(r, "L")).toBe("fallback");
    expect(r.routes.find((x) => x.id.endsWith("/m"))!.tier).toBe("fallback");
  });

  test("forwardRef and memo wrappers are read, and a component rendering itself terminates", () => {
    const r = classifyApp(
      app({
        "routes/n.tsx": `import { forwardRef, memo } from "react";
const Plain = memo(function Plain() { return <p>x</p>; });
const Wrapped = forwardRef<HTMLDivElement, {}>((props, ref) => <div ref={ref} />);
export default function N() { return <><Plain /><Wrapped /><N /></>; }`,
      }),
    );
    expect(tierOf(r, "Plain")).toBe("page");
    expect(tierOf(r, "Wrapped")).toBe("page");
    expect(tierOf(r, "N")).toBe("page");
  });

  test("the starter: its home page is a page; the chat, the sign-in form and the header are islands", () => {
    const r = classifyApp(
      join(import.meta.dir, "../../create-archlast-forge/template/framework"),
    );
    expect(
      Object.fromEntries(
        r.routes.map((x) => [x.id.replace(/^.*\//, ""), x.tier]),
      ),
    ).toEqual({ index: "page", chat: "island", "sign-in": "island" });
    expect(tierOf(r, "Chrome")).toBe("island"); // the header: the sign-out button is in it
    // The header is an island and lives in the file `Root` is in, and it would also be handed the page: until its interactive part is a
    // component of its own, in a file of its own, the root layout is an island and the whole page hydrates. The report is how an app finds out.
    expect(r.components.find((c) => c.name === "Root")!.reasons[0]).toContain(
      "renders Chrome, which is an island used in the file that declares it",
    );
  });

  test("islands are mounted from their own file by the name they export; one used where it is declared, or not exported, cannot be", () => {
    const r = classifyApp(
      app({
        "root.tsx": `import { Menu } from "./_c/menu";
import { Outlet } from "@archlast/forge-framework";
export default function Root() { return <div><Menu /><Outlet /></div>; }`,
        "_c/menu.tsx": `import { useState } from "react";
export function Menu() { const [o] = useState(false); return <nav>{String(o)}</nav>; }`,
        "routes/index.tsx": `export default function Home() { return <p>hi</p>; }`,
        "routes/live.tsx": `import { useState } from "react";
export default function Live() { const [n] = useState(0); return <p>{n}</p>; }`,
        "routes/same.tsx": `import { useState } from "react";
function Inner() { const [n] = useState(0); return <b>{n}</b>; }
export default function Same() { return <p><Inner /></p>; }`,
      }),
    );
    expect(tierOf(r, "Root")).toBe("page");
    expect(r.mounts.map((m) => `${m.name}:${m.exportName}`).sort()).toEqual(["Live:default", "Menu:Menu", "Same:default"]);
    expect(tierOf(r, "Same")).toBe("island"); // Inner cannot be mounted on its own
    expect(r.components.find((c) => c.name === "Same")!.reasons[0]).toContain("used in the file that declares it");
  });

  test("the report reads well", () => {
    const root = app({
      "routes/index.tsx": `export default function Home() { return <p>hi</p>; }`,
    });
    const text = formatReport(classifyApp(root), root);
    expect(text).toContain("page     routes/index");
    expect(text).toContain("1 page, 0 island, 0 fallback");
  });
});
