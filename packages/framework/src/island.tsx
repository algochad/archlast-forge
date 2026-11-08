// The server side of an island: the build wraps the island's export with this, so where a page renders it the HTML carries a marker with the island's id
// and its props, and the island's own output inside. The browser's islands.tsx finds the markers and hydrates each one alone.
import { createContext, useContext, type ComponentType } from "react";

/** Whether this render is of a page that has islands. Where it is not (a page rendered and hydrated as a whole) an island is just its component. */
export const IslandsContext = createContext(false);

/** Props that can cross to the browser as JSON: data, not functions or elements. */
function assertPlain(value: unknown, path: string, id: string): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  const bad = (what: string) => {
    throw new Error(`The island ${id} was given ${what} in ${path}. An island's props are sent to the browser as JSON: pass data (strings, numbers, booleans, arrays, plain objects), and let the island do the rest.`);
  };
  if (value === undefined) return; // dropped by JSON, and read back as undefined
  if (typeof value === "function") return bad("a function");
  if (typeof value === "symbol" || typeof value === "bigint") return bad(`a ${typeof value}`);
  if (typeof value !== "object") return;
  if ("$$typeof" in value) return bad("an element");
  if (Array.isArray(value)) return value.forEach((v, i) => assertPlain(v, `${path}[${i}]`, id));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return bad(`an instance of ${proto?.constructor?.name ?? "a class"}`);
  for (const [k, v] of Object.entries(value)) assertPlain(v, `${path}.${k}`, id);
}

/** Wraps `Component` as the island `id` ("<file in app/>#<export name>"). */
export function island<P extends object>(Component: ComponentType<P>, id: string): ComponentType<P> {
  const Island = (props: P) => {
    if (!useContext(IslandsContext)) return <Component {...props} />;
    if ("children" in props && (props as { children?: unknown }).children !== undefined) throw new Error(`The island ${id} was given children. An island is hydrated on its own, so it cannot receive elements: render them inside it.`);
    assertPlain(props, "its props", id);
    return (
      // `display: contents`: the marker takes no part in layout.
      <div data-forge-island={id} data-props={JSON.stringify(props)} style={{ display: "contents" }}>
        <Component {...props} />
      </div>
    );
  };
  Island.displayName = `Island(${id})`;
  return Island;
}
