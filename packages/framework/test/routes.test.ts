import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRoutes, type RouteFile } from "../src/routes";

function app(files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "afx-routes-"));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "export default () => null");
  }
  return dir;
}
/** Routes as "path|index|id" lines, nested by indentation, so the shape reads at a glance. */
const show = (routes: RouteFile[], depth = 0): string[] =>
  routes.flatMap((r) => [`${"  ".repeat(depth)}${r.index ? "(index)" : (r.path ?? "(pathless)")} ${r.file}`, ...show(r.children ?? [], depth + 1)]);

test("files become paths: index, plain, nested, params and splats", () => {
  const dir = app(["root.tsx", "routes/index.tsx", "routes/about.tsx", "routes/blog/index.tsx", "routes/blog/[slug].tsx", "routes/docs/[...path].tsx"]);
  const tree = scanRoutes(dir);
  expect(tree.root).toBe("root.tsx");
  expect(show(tree.routes)).toEqual([
    "about routes/about.tsx",
    "blog/:slug routes/blog/[slug].tsx",
    "blog routes/blog/index.tsx",
    "docs/* routes/docs/[...path].tsx",
    "(index) routes/index.tsx",
  ]);
});

test("a _layout.tsx wraps its directory; (group) directories add no path", () => {
  const tree = scanRoutes(app(["routes/index.tsx", "routes/(app)/_layout.tsx", "routes/(app)/chat.tsx", "routes/(app)/settings/index.tsx", "routes/blog/_layout.tsx", "routes/blog/index.tsx", "routes/blog/[slug].tsx"]));
  expect(show(tree.routes)).toEqual([
    "(pathless) routes/(app)/_layout.tsx",
    "  chat routes/(app)/chat.tsx",
    "  settings routes/(app)/settings/index.tsx",
    "blog routes/blog/_layout.tsx",
    "  :slug routes/blog/[slug].tsx",
    "  (index) routes/blog/index.tsx",
    "(index) routes/index.tsx",
  ]);
  expect(tree.routes.find((r) => r.file.endsWith("blog/_layout.tsx"))?.id).toBe("routes/blog/_layout");
});

test("private files, tests and other file types are not routes", () => {
  const tree = scanRoutes(app(["routes/index.tsx", "routes/_helpers.ts", "routes/_components/Button.tsx", "routes/about.test.tsx", "routes/styles.css", "routes/types.d.ts", "routes/.hidden.tsx"]));
  expect(show(tree.routes)).toEqual(["(index) routes/index.tsx"]);
});

test("mistakes fail with the file and a fix", () => {
  expect(() => scanRoutes(app(["root.tsx"]))).toThrow("No routes directory");
  expect(() => scanRoutes(app(["routes/_x.tsx"]))).toThrow("has no routes");
  expect(() => scanRoutes(app(["routes/about.tsx", "routes/about/index.tsx"]))).toThrow("both answer /about");
  expect(() => scanRoutes(app(["routes/post-[id].tsx"]))).toThrow("mixes a dynamic part");
  expect(() => scanRoutes(app(["routes/blog/[id].tsx", "routes/blog/[slug].tsx"]))).toThrow("the same URLs (/blog/:id and /blog/:slug: parameter names don't tell routes apart)");
  expect(() => scanRoutes(app(["routes/[...rest]/x.tsx"]))).toThrow("must be a file");
  expect(() => scanRoutes(app(["routes/a b.tsx"]))).toThrow("can't be part of a URL path");
});
