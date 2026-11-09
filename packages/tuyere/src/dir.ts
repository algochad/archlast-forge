/**
 * `{ dir }` routes: `"/static/*": { dir: "./public" }` serves a directory tree, the way Bun does. The files themselves are sent by Rust
 * (`FileReply`: ranges, validators, content type from the extension); this decides which file a URL names.
 *
 * Only canonical paths are served: no `.`, `..` or empty segments, no encoded `/` or NUL, and no `%XX` for a character that may stand
 * literally in a path segment (`/a%2Eb` and `/%61` are 404, the path the router matched is the path that is served). A symlink that leaves
 * `dir` is a 404 (Bun's kernel-side `RESOLVE_IN_ROOT` clamps it to the root instead). A directory without the trailing `/` is a 301 to the
 * one with it, which serves its `index.html`.
 */
import { realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { FileReply } from "./file.ts";
import { Reply } from "./server.ts";

export interface DirectoryRoute {
  dir: string;
  /** Accepted for compatibility: validators are cheap here and always computed. */
  statCache?: boolean;
}

/** An object with a string `dir`, and nothing a method map would have. */
export function isDirectoryRoute(v: unknown): v is DirectoryRoute {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof Response) &&
    !(v instanceof Blob) &&
    typeof (v as DirectoryRoute).dir === "string"
  );
}

const LITERAL = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/;
const notFound = () => new Reply("Not Found", { status: 404 });

/** The decoded segment, or null when its spelling is not the canonical one. */
function canonical(segment: string): string | null {
  if (segment === "" || segment === "." || segment === "..") return null;
  for (const m of segment.matchAll(/%([0-9A-Fa-f]{2})/g)) {
    const code = parseInt(m[1]!, 16);
    if (
      code < 0x80 &&
      (LITERAL.test(String.fromCharCode(code)) ||
        code === 0x2f ||
        code === 0x5c ||
        code === 0)
    )
      return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
    ? null
    : decoded;
}

export function directoryHandler(
  pattern: string,
  route: DirectoryRoute,
): (req: Request) => Response | Reply | FileReply {
  if (!pattern.endsWith("/*"))
    throw new TypeError(`route ${pattern}: a { dir } route must end in "/*"`);
  const prefix = pattern.slice(0, -1); // keeps the slash: "/static/"
  const base = resolve(route.dir);
  return (req) => {
    if (req.method !== "GET" && req.method !== "HEAD")
      return new Reply("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) return notFound();
    const rel = url.pathname.slice(prefix.length);
    const trailing = rel === "" || rel.endsWith("/");
    const parts =
      rel === "" ? [] : (trailing ? rel.slice(0, -1) : rel).split("/");
    const names: string[] = [];
    for (const p of parts) {
      const c = canonical(p);
      if (c === null) return notFound();
      names.push(c);
    }
    let root: string, target: string;
    try {
      root = realpathSync(base);
      target = realpathSync(join(root, ...names));
    } catch {
      return notFound();
    }
    if (target !== root && !target.startsWith(root + sep)) return notFound();
    let info;
    try {
      info = statSync(target);
    } catch {
      return notFound();
    }
    if (info.isDirectory()) {
      if (!trailing && names.length > 0)
        return new Reply(null, {
          status: 301,
          headers: { location: url.pathname + "/" + url.search },
        });
      const index = join(target, "index.html");
      try {
        if (!statSync(index).isFile()) return notFound();
      } catch {
        return notFound();
      }
      return new FileReply(index);
    }
    if (!info.isFile() || trailing) return notFound();
    return new FileReply(target);
  };
}
