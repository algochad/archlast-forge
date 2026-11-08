import { useLoaderData, type LoaderArgs } from "@archlast/forge-framework";
import { anyApi } from "@archlast/forge-runtime";

// Kept for anonymous visitors, with no tags of its own: a write to `items` is what ends it.
export const handle = { cache: { ttl: 60 } };

export const loader = async ({ ctx }: LoaderArgs) => ({ total: (await ctx.query(anyApi.items.total)) as number });

let renders = 0;

export default function CachedItems() {
  const { total } = useLoaderData() as { total: number };
  renders++;
  return (
    <p id="total">
      {total} items, rendered {renders}
    </p>
  );
}
