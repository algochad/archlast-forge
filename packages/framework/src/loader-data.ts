import { useLoaderData as useRouterLoaderData } from "react-router";

/**
 * What this route's `loader` returned: `useLoaderData<typeof loader>()`.
 * It went through JSON on the way to the browser, so dates arrive as strings and `undefined` fields are gone.
 */
export function useLoaderData<L extends (...args: never[]) => unknown>(): Awaited<ReturnType<L>> {
  return useRouterLoaderData() as Awaited<ReturnType<L>>;
}
