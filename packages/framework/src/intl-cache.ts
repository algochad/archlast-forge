// Formatters made once. `new Intl.NumberFormat(locale, options)` costs far more than `.format()`, and a page that writes a price or a date in every cell of a table
// (the usual way: `formatMoney(cents)` building its formatter inside) pays it per cell: in a real ERP's pages it was a third of the server's time. A formatter holds no
// state that changes after it is made, so asking again for the same locale and options can hand back the first one; this does that for the server process.
//
// A request that cannot be keyed safely (a non-plain object among the arguments) is made as usual. `new Intl.DateTimeFormat()` with no time zone follows the process's TZ
// when it is made, so TZ is part of its key. Turn it off with FORGE_MEMO_INTL=0.

const NAMES = ["NumberFormat", "DateTimeFormat", "PluralRules", "RelativeTimeFormat", "ListFormat", "Collator", "DisplayNames", "Segmenter"] as const;
const LIMIT = 500;
const INSTALLED = Symbol.for("archlast-forge.intl-memo");

/** A string that names these arguments, or undefined when they hold something that is not plain data. */
function keyOf(name: string, args: unknown[]): string | undefined {
  const plain = (v: unknown, depth: number): boolean => {
    if (v === null || ["string", "number", "boolean", "undefined"].includes(typeof v)) return true;
    if (depth > 3 || typeof v !== "object") return false;
    if (Array.isArray(v)) return v.every((x) => plain(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    return (proto === Object.prototype || proto === null) && Object.values(v as object).every((x) => plain(x, depth + 1));
  };
  if (!args.every((a) => plain(a, 0))) return undefined;
  const opts = args[1] as { timeZone?: unknown } | undefined;
  // `undefined` is not JSON, and trailing ones make no difference to the formatter.
  const tz = name === "DateTimeFormat" && !(opts && opts.timeZone !== undefined) ? (process.env.TZ ?? "") : "";
  let n = args.length;
  while (n > 0 && args[n - 1] === undefined) n--;
  return JSON.stringify([args.slice(0, n).map((a) => (a === undefined ? null : a)), tz]);
}

/** Replaces the constructors on `Intl` with ones that return the same formatter for the same arguments. Safe to call more than once. */
export function memoizeIntl(): void {
  const intl = Intl as unknown as Record<string | symbol, unknown>;
  if (intl[INSTALLED]) return;
  for (const name of NAMES) {
    const Original = intl[name] as (new (...a: unknown[]) => object) | undefined;
    if (typeof Original !== "function") continue;
    const cache = new Map<string, object>();
    const made = (args: unknown[], make: () => object) => {
      const key = keyOf(name, args);
      if (key === undefined) return make();
      let found = cache.get(key);
      if (!found) {
        if (cache.size >= LIMIT) cache.clear();
        cache.set(key, (found = make()));
      }
      return found;
    };
    const proxy: unknown = new Proxy(Original, {
      construct: (target, args, newTarget) => (newTarget === proxy ? made(args, () => Reflect.construct(target, args)) : Reflect.construct(target, args, newTarget)),
      apply: (target, _this, args) => made(args, () => Reflect.apply(target, undefined, args) as object),
    });
    intl[name] = proxy;
  }
  Object.defineProperty(intl, INSTALLED, { value: true });
}
