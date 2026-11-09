import { describe, expect, test } from "bun:test";
import { matchRoute } from "../src/server/http";
import { looksLikeId, normalizePath } from "../src/server/telemetry/recorder";

// What matchRoute and normalizePath answered before they were made faster: they must still answer the same.
type R = { method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"; path?: string; pathPrefix?: string };
function reference(routes: R[], method: string, path: string) {
  const here = routes.filter((r) => (r.path !== undefined ? r.path === path : path.startsWith(r.pathPrefix!)));
  if (!here.length) return { status: 404 };
  const ofMethod = here.filter((r) => r.method === method);
  const best = ofMethod.find((r) => r.path !== undefined) ?? ofMethod.sort((a, b) => b.pathPrefix!.length - a.pathPrefix!.length)[0];
  return best ? { route: best } : { status: 405, allow: [...new Set(here.map((r) => r.method))] };
}
const OLD_ID = /^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27}$|^[0-9a-f]{16,}$|^(?=.*\d)[A-Za-z0-9_-]{20,}$/i;
const oldNormalize = (path: string) =>
  path
    .split("/")
    .map((seg) => (OLD_ID.test(seg) ? ":id" : seg))
    .join("/") || "/";

describe("matchRoute", () => {
  const methods = ["GET", "POST", "PUT"] as const;
  const routes: R[] = [
    { method: "GET", path: "/items" },
    { method: "POST", path: "/items" },
    { method: "GET", pathPrefix: "/items/" },
    { method: "PUT", pathPrefix: "/items/" },
    { method: "GET", pathPrefix: "/items/special/" },
    { method: "GET", pathPrefix: "/files" },
    { method: "POST", pathPrefix: "/files" },
    { method: "GET", pathPrefix: "/files" }, // declared twice: the first wins
    { method: "GET", path: "/" },
    { method: "GET", pathPrefix: "/" },
    { method: "DELETE", path: "/gone" },
  ];
  const paths = ["/", "/items", "/items/", "/items/5", "/items/special/9", "/items/special", "/files", "/files/a/b", "/filesX", "/gone", "/nothing", "", "/items?x", "/ITEMS"];

  test("answers as the scan did, for every method and path", () => {
    for (const method of [...methods, "DELETE", "PATCH"]) for (const path of paths) expect(matchRoute(routes, method, path), `${method} ${path}`).toEqual(reference(routes, method, path) as never);
  });

  test("is not slowed or changed by many different paths", () => {
    for (let i = 0; i < 5000; i++) expect(matchRoute(routes, "GET", `/items/${i}`)).toEqual({ route: routes[2]! });
  });

  test("sees routes added to the list after a first answer", () => {
    const list: R[] = [{ method: "GET", path: "/a" }];
    expect(matchRoute(list, "GET", "/b")).toEqual({ status: 404 });
    list.push({ method: "GET", path: "/b" });
    expect(matchRoute(list, "GET", "/b")).toEqual({ route: list[1]! });
  });
});

describe("normalizePath", () => {
  const segments = [
    "", "items", "5", "0", "12345678901234567890", "8f2c0a6e-1b2d-4c3e-9f10-aabbccddeeff", "8F2C0A6E-1B2D-4C3E-9F10-AABBCCDDEEFF", "8f2c0a6e-1b2d-4c3e-9f10-aabbccddeef", "0123456789abcdef", "0123456789abcde",
    "0123456789ABCDEFab", "abcdefabcdefabcd", "abcdefabcdefabc", "reset-password", "a1b2c3d4e5f6g7h8i9j0", "abcdefghijklmnopqrst", "abcdefghijklmnopqrs1", "abcdefghijklmnop-rst1", "ünïcode", "12ü", "a_b-c", "ABC", "ſ12345678901234567890", "1e5",
    "token_with_underscores_12345", "Token-With-Dashes-And-9", "x".repeat(40), `${"a".repeat(19)}9`, `${"a".repeat(20)}`, "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-00000000000-", "-".repeat(36),
  ];
  test("looksLikeId and normalizePath answer as the regular expressions did", () => {
    for (const seg of segments) expect(looksLikeId(seg), JSON.stringify(seg)).toBe(OLD_ID.test(seg));
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const alphabet = "0123456789abcdefABCDEFghijkXYZ_-.ü/";
    for (let i = 0; i < 20000; i++) {
      const len = rnd(45);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[rnd(alphabet.length)];
      expect(normalizePath(s), JSON.stringify(s)).toBe(oldNormalize(s));
    }
    for (const a of segments) for (const b of segments) expect(normalizePath(`/${a}/${b}`)).toBe(oldNormalize(`/${a}/${b}`));
  });
});
