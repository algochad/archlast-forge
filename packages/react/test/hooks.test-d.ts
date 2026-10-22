// Compile-time only (checked by `bun check`): hook signatures come from function references.
import type { FunctionReference, Id } from "@archlast-forge/runtime";
import { expectTypeOf } from "expect-type";
import { useAction, useMutation, useQuery } from "../src/index";

type Todo = { _id: Id<"todos">; title: string };
declare const api: {
  todos: {
    listByList: FunctionReference<"query", { listId: Id<"lists"> }, Todo[]>;
    all: FunctionReference<"query", {}, Todo[]>;
    add: FunctionReference<"mutation", { listId: Id<"lists">; title: string }, Id<"todos">>;
    remind: FunctionReference<"action", { todoId: Id<"todos"> }, string>;
  };
};
declare const listId: Id<"lists">;

export function Component() {
  expectTypeOf(useQuery(api.todos.listByList, { listId })).toEqualTypeOf<Todo[] | undefined>();
  expectTypeOf(useQuery(api.todos.all)).toEqualTypeOf<Todo[] | undefined>();
  // @ts-expect-error args are required when the function takes some
  useQuery(api.todos.listByList);
  // @ts-expect-error wrong arg type
  useQuery(api.todos.listByList, { listId: 1 });
  // @ts-expect-error a mutation is not a query
  useQuery(api.todos.add, { listId, title: "x" });
  const add = useMutation(api.todos.add);
  expectTypeOf(add({ listId, title: "milk" })).toEqualTypeOf<Promise<Id<"todos">>>();
  const remind = useAction(api.todos.remind);
  expectTypeOf(remind).parameters.toEqualTypeOf<[args: { todoId: Id<"todos"> }]>();
}
