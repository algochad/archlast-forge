import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

/**
 * What the server rendered the page with. The browser's first (hydrating) render must use the same values, or what it
 * renders differs from the HTML and React throws the server's page away; after hydration they follow the browser's own.
 */
export interface TimeState {
  /** The instant the server rendered the page. */
  now: number;
  /** The time zone it formatted times in: the visitor's, if the browser has told the server, otherwise UTC. */
  timeZone: string;
}

export const TimeContext = createContext<TimeState | undefined>(undefined);

/** The cookie the browser sets (only once a component has called `useTimeZone`) so the next server render knows the visitor's zone. */
export const ZONE_COOKIE = "forge-tz";
export const DEFAULT_ZONE = "UTC";

/** True for a time zone name this runtime formats with. The name comes from a cookie, so it is checked before it is used for anything. */
export function validZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone in a `Cookie` header, or undefined when there isn't one or it isn't a zone. */
export function zoneFromCookie(header: string | null | undefined): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== ZONE_COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
    return validZone(value) ? value : undefined;
  }
  return undefined;
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const never = () => () => {};

/**
 * The visitor's time zone, as a name like "Asia/Manila". Format times with it (`Intl.DateTimeFormat(locale, { timeZone })`,
 * or date-fns-tz) and the server's HTML and the browser agree.
 *
 * The browser tells the server its zone in a cookie, which the first visit doesn't have yet: that one is rendered in UTC on the server and
 * in the browser's hydrating render, then switches to the visitor's own zone as soon as the page is hydrated, and the cookie is set for next time.
 */
export function useTimeZone(): string {
  const time = useContext(TimeContext);
  // Hydrating, React uses the third argument (what the server rendered with); afterwards, and on navigations, the second.
  const zone = useSyncExternalStore(never, browserZone, () => time?.timeZone ?? DEFAULT_ZONE);
  useEffect(() => {
    const here = browserZone();
    if (!validZone(here) || zoneFromCookie(document.cookie) === here) return;
    document.cookie = `${ZONE_COOKIE}=${here}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }, []);
  return zone;
}

/** The start of the interval that contains `time`. */
export const windowOf = (time: number, interval: number) => Math.floor(time / interval) * interval;

/** One timer per interval, shared by every component that asks for it, aligned to the clock so all of them tick together. */
const clocks = new Map<number, { subscribe(listener: () => void): () => void; get(): number }>();

function clockOf(interval: number) {
  let clock = clocks.get(interval);
  if (clock) return clock;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(
      () => {
        for (const l of [...listeners]) l();
        arm();
      },
      interval - (Date.now() % interval) + 1,
    );
  };
  clock = {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) arm();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) clearTimeout(timer);
      };
    },
    get: () => windowOf(Date.now(), interval),
  };
  clocks.set(interval, clock);
  return clock;
}

/**
 * The current time in milliseconds, rounded down to `interval` (a minute unless you say otherwise), kept current: the component renders again
 * each time the interval turns. Use it instead of `Date.now()` or `new Date()` while rendering ("3 hours ago", the day of a stay).
 *
 * While the browser hydrates the page it returns the instant the server rendered at, so both render the same text; as soon as the page is
 * hydrated it moves to the real time (when that is a later interval, the text updates in place). A `Date.now()` in the render would give the
 * server's moment on one side and the browser's, seconds later, on the other.
 */
export function useNow(interval = 60_000): number {
  const time = useContext(TimeContext);
  const clock = clockOf(interval);
  return useSyncExternalStore(clock.subscribe, clock.get, () => windowOf(time?.now ?? Date.now(), interval));
}
