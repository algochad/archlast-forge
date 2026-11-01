// What the browser says when the page it rendered differs from the HTML the server sent.

/** What React reports for a mismatch, in development and minified (418: text, 422 and 423: a boundary or the whole page rendered again, 425: text during hydration). */
const MISMATCH = /Hydration failed|didn't match|did not match|Minified React error #(418|422|423|425)\b/i;

export const isHydrationMismatch = (error: unknown) => MISMATCH.test(String((error as Error)?.message ?? error));

export const HINT =
  "[archlast-forge] The server and the browser rendered different text, so React discarded the server's HTML and rendered the page again in the browser. " +
  "Dates and the clock are the usual cause: format times with the zone from useTimeZone(), read the time with useNow() instead of Date.now() or new Date(), " +
  'and work out arguments that come from the clock in the loader and read them with useLoaderData(). See "Times and the clock" in the full-stack guide.';

/**
 * React calls this for errors it recovered from (for a mismatch, by rendering the page again). It does what React does without a handler, so error
 * trackers that listen for window errors still see it, and adds the way out of the most common cause. `notice` shows it on the page in development.
 */
export function reportRecoverableError(error: unknown, notice?: (title: string, message: string) => void) {
  if (typeof reportError === "function") reportError(error);
  else console.error(error);
  if (!isHydrationMismatch(error)) return;
  console.warn(HINT);
  notice?.("Hydration mismatch", `${HINT}\n\nThe console has the component and the text that differed.`);
}
