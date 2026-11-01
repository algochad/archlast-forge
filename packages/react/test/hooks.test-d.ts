// Compile-time only (checked by `bun check`): hook signatures come from function references.
import type { FunctionReference, Id, PaginationOptions, PaginationResult } from "@archlast/forge-runtime";
import { expectTypeOf } from "expect-type";
import { pageArgs, useAction, useMutation, useNumberedPage, usePaginatedQuery, useQuery, useUploadFile } from "../src/index";

type Todo = { _id: Id<"todos">; title: string };
declare const api: {
  todos: {
    listByList: FunctionReference<"query", { listId: Id<"lists"> }, Todo[], "public">;
    all: FunctionReference<"query", {}, Todo[], "public">;
    page: FunctionReference<"query", { listId: Id<"lists">; paginationOpts: PaginationOptions }, PaginationResult<Todo>, "public">;
    add: FunctionReference<"mutation", { listId: Id<"lists">; title: string }, Id<"todos">, "public">;
    remind: FunctionReference<"action", { todoId: Id<"todos"> }, string, "public">;
    uploadUrl: FunctionReference<"mutation", { contentType?: string }, { uploadUrl: string; storageId: Id<"_storage"> }, "public">;
  };
};
declare const internal: { todos: { purge: FunctionReference<"mutation", {}, null, "internal">; secret: FunctionReference<"query", {}, string, "internal"> } };
declare const listId: Id<"lists">;

export function Component() {
  expectTypeOf(useQuery(api.todos.listByList, { listId })).toEqualTypeOf<Todo[] | undefined>();
  expectTypeOf(useQuery(api.todos.all)).toEqualTypeOf<Todo[] | undefined>();
  expectTypeOf(useQuery(api.todos.listByList, "skip")).toEqualTypeOf<Todo[] | undefined>();
  // @ts-expect-error args are required when the function takes some
  useQuery(api.todos.listByList);
  // @ts-expect-error wrong arg type
  useQuery(api.todos.listByList, { listId: 1 });
  // @ts-expect-error a mutation is not a query
  useQuery(api.todos.add, { listId, title: "x" });
  // @ts-expect-error internal functions can't be called from clients
  useQuery(internal.todos.secret);
  // @ts-expect-error internal functions can't be called from clients
  useMutation(internal.todos.purge);

  const add = useMutation(api.todos.add);
  expectTypeOf(add({ listId, title: "milk" })).toEqualTypeOf<Promise<Id<"todos">>>();
  const addOptimistic = add.withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.todos.listByList, { listId: args.listId });
    expectTypeOf(current).toEqualTypeOf<Todo[] | undefined>();
    store.setQuery(api.todos.listByList, { listId: args.listId }, [...(current ?? []), { _id: "todos:tmp" as Id<"todos">, title: args.title }]);
  });
  expectTypeOf(addOptimistic).returns.toEqualTypeOf<Promise<Id<"todos">>>();

  const remind = useAction(api.todos.remind);
  expectTypeOf(remind).parameters.toEqualTypeOf<[args: { todoId: Id<"todos"> }]>();

  const { results, loadMore, status } = usePaginatedQuery(api.todos.page, { listId }, { initialNumItems: 10 });
  expectTypeOf(results).toEqualTypeOf<Todo[]>();
  expectTypeOf(loadMore).parameters.toEqualTypeOf<[n: number]>();
  expectTypeOf(status).toEqualTypeOf<"LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted">();

  // The same query, as numbered pages.
  const table = useNumberedPage(api.todos.page, { listId }, { page: 2, pageSize: 20 });
  expectTypeOf(table.results).toEqualTypeOf<Todo[]>();
  expectTypeOf(table.total).toEqualTypeOf<number | undefined>();
  expectTypeOf(table.pageCount).toEqualTypeOf<number | undefined>();
  expectTypeOf(table.hasNextPage).toEqualTypeOf<boolean>();
  useNumberedPage(api.todos.page, "skip", { page: 1, pageSize: 20 });
  // @ts-expect-error a query that isn't paginated
  useNumberedPage(api.todos.listByList, { listId }, { page: 1, pageSize: 20 });
  expectTypeOf(pageArgs({ listId }, 3, 20).paginationOpts).toEqualTypeOf<{ numItems: number; cursor: null; offset: number; withTotal: boolean }>();

  const upload = useUploadFile(api.todos.uploadUrl);
  expectTypeOf(upload).returns.toEqualTypeOf<Promise<Id<"_storage">>>();
}
