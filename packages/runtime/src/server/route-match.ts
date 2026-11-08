// A matcher for the paths most routes have, made of fixed segments and `:name` parameters (`/users/:id/posts`), that answers as path-to-regexp's `match` does
// (end of path, a trailing slash allowed, case ignored, a parameter is one non-empty segment decoded with decodeURIComponent) without a regular expression
// or a copy of the segments. A path it is unsure of (a `%` that does not decode) goes to path-to-regexp, which is what `matcher` is given to fall back on.

export type Matched = false | { params: Record<string, string> };

const SEGMENT = /^(?::[A-Za-z_$][\w$]*|[A-Za-z0-9_.~-]+)$/;

/** The fast matcher for `pattern`, or null when the pattern has anything but fixed segments and plain parameters. */
export function simpleMatcher(pattern: string, fallback: (path: string) => Matched): ((path: string) => Matched) | null {
  if (!pattern.startsWith("/")) return null;
  const segments = pattern === "/" ? [] : pattern.slice(1).split("/");
  if (!segments.every((s) => SEGMENT.test(s))) return null;
  const fixed = segments.map((s) => (s.startsWith(":") ? null : s.toLowerCase()));
  const names = segments.map((s) => (s.startsWith(":") ? s.slice(1) : null));
  const count = segments.length;
  return (path) => {
    // the path without its trailing slash (the root keeps its own)
    let end = path.length;
    if (end > 1 && path.charCodeAt(end - 1) === 47) end--;
    if (path.charCodeAt(0) !== 47) return false;
    let params: Record<string, string> | undefined;
    let at = 1;
    if (count === 0) return end === 1 || end === 0 ? { params: {} } : false;
    for (let i = 0; i < count; i++) {
      let next = path.indexOf("/", at);
      if (next < 0 || next > end) next = end;
      if (next === at) return false; // an empty segment
      const f = fixed[i];
      if (f !== null) {
        if (next - at !== f!.length || path.slice(at, next).toLowerCase() !== f) return false;
      } else {
        let value = path.slice(at, next);
        if (value.indexOf("%") >= 0) {
          try {
            value = decodeURIComponent(value);
          } catch {
            return fallback(path);
          }
        }
        (params ??= {})[names[i]!] = value;
      }
      at = next + 1;
      if (i < count - 1 && next >= end) return false; // fewer segments than the pattern
    }
    // the last segment must end the path
    return at - 1 === end || at > end ? { params: params ?? {} } : false;
  };
}
