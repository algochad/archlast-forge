import { describe, expect, test } from "bun:test";
import { match } from "path-to-regexp";
import { simpleMatcher } from "../src/server/route-match";

// The fast matcher must answer as path-to-regexp does for every path.
const PATTERNS = ["/", "/items", "/items/:id", "/users/:userId/posts/:postId", "/a/b/c", "/Mixed/Case/:Name", "/files/:name.json"];
const PATHS = [
  "/", "", "//", "/items", "/items/", "/items//", "/Items", "/ITEMS/5", "/items/5", "/items/5/", "/items/5/6", "/items/%41", "/items/%e4%bd%a0", "/items/%zz", "/items/a%2Fb",
  "/items/a b", "/items/ünï", "/users/1/posts/2", "/users/1/posts", "/users/1/posts/", "/users//posts/2", "/a/b/c", "/a/b/c/", "/a/b", "/a/b/c/d", "/mixed/case/Bob", "/MIXED/CASE/bob",
  "/files/x.json", "/files/x.JSON", "/files/x", "items", "/items/5?x=1", "/items/5#h", "/items/.", "/items/..", "/items/a.b-c_d~e",
];

describe("simpleMatcher", () => {
  for (const pattern of PATTERNS) {
    const reference = match(pattern, { decode: decodeURIComponent, end: true });
    const run = (path: string) => {
      try {
        return reference(path);
      } catch {
        return "throws" as const;
      }
    };
    const fast = simpleMatcher(pattern, (p): false | { params: Record<string, string> } => {
      const r = run(p);
      return r === "throws" ? false : (r as false | { params: Record<string, string> });
    });
    test(`${pattern} matches what path-to-regexp matches`, () => {
      if (!fast) return expect(pattern).toBe("/files/:name.json"); // the one pattern the fast matcher declines
      for (const path of PATHS) {
        const expected = run(path);
        const got = fast(path);
        if (expected === "throws") expect(got, path).toBe(false);
        else expect(got === false ? false : got.params, path).toEqual((expected === false ? false : (expected as { params: unknown }).params) as never);
      }
    });
  }

  test("a pattern with anything but fixed segments and plain parameters is declined", () => {
    for (const p of ["/a/*splat", "/a{/:b}", "/a/:b?", "items", "/a/:1", "/a/b c"]) expect(simpleMatcher(p, () => false)).toBeNull();
  });
});
