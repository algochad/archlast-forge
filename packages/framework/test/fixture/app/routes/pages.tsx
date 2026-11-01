import { anyApi } from "@archlast/forge-runtime";
import { pageArgs, useNumberedPage, usePaginatedQuery, windowArgs } from "@archlast/forge-react";
import { useLoaderData, type LoaderArgs } from "@archlast/forge-framework";
import { useState } from "react";

const api = anyApi;
const SIZE = 3;

export const loader = async ({ request, ctx }: LoaderArgs) => {
  const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
  await Promise.all([ctx.query(api.items.page, pageArgs({}, page, SIZE)), ctx.query(api.items.page, windowArgs({}, 2))]);
  return { page };
};

export default function Pages() {
  const [page, setPage] = useState(useLoaderData<typeof loader>().page);
  const table = useNumberedPage(api.items.page, {}, { page, pageSize: SIZE });
  const list = usePaginatedQuery(api.items.page, {}, { initialNumItems: 2 });
  const ns = (rows: { n: number }[]) => rows.map((r) => r.n).join(",");
  return (
    <main>
      <p id="table">{ns(table.results as { n: number }[])}</p>
      <p id="where">
        page {page} of {table.pageCount} ({table.total} items){table.hasNextPage ? "" : ", last"}
      </p>
      <button id="next" onClick={() => setPage(page + 1)} disabled={!table.hasNextPage}>
        next
      </button>
      <p id="list">{ns(list.results as { n: number }[])}</p>
      <button id="more" onClick={() => list.loadMore(2)}>
        more
      </button>
    </main>
  );
}
