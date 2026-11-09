/** What a handler tells the engine about a response it would like kept and served again without running the handler (see crates/core/src/pagecache.rs). */
export interface CacheRules {
  /** Seconds the response is served. */
  ttl: number;
  /** Cookies whose values are part of the key: a different value is another entry. */
  varyCookie?: string[];
  /** When given, a request carrying any other cookie (besides the varied ones) bypasses the cache. */
  onlyCookie?: string[];
  /** Cookies and headers that bypass the cache when a request has them. */
  skipCookie?: string[];
  skipHeader?: string[];
  /** Labels for `purgeCache`. */
  tags?: string[];
}

/** The name of the header a handler sets on a response to opt it in. The engine removes it before the response is sent. */
export const CACHE_HEADER = "x-archlast-cache";

/** The value of `x-archlast-cache` for these rules. Only complete 200 responses to GET are kept, and never one that sets a cookie or says `no-store`. */
export function cacheHeader(r: CacheRules): string {
  if (!(r.ttl > 0)) throw new RangeError("cache: ttl is a number of seconds above 0");
  const list = (name: string, v?: string[]) => (v?.length ? `${name}=${v.join(",")}` : undefined);
  return [`ttl=${Math.floor(r.ttl)}`, list("vary-cookie", r.varyCookie), list("only-cookie", r.onlyCookie), list("skip-cookie", r.skipCookie), list("skip-header", r.skipHeader), list("tag", r.tags)]
    .filter(Boolean)
    .join("; ");
}
