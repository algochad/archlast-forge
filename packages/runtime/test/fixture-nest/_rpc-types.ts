// Type checks for Forge RPC clients, run by `bun check -p test/fixture-nest`: each @ts-expect-error must stay an error. The Rpc type is what
// codegen writes for shop.router.ts (packages/cli/test/rpc-codegen.test.ts). The leading _ keeps the engine from loading this as a module.
import type { ForgeRpcClientOf } from "../../src/nest-rpc";
import type * as m0 from "./shop.router";

interface Rpc {
  shop: {
    add: { kind: "query"; input: { a: number; b: number }; output: { sum: number } };
    order: { kind: "mutation"; input: { userId: string; items: Array<{ sku: string; qty: number }> }; output: { orderId: string; units: number } };
    notes: { kind: "query"; input: undefined; output: Awaited<ReturnType<m0.ShopRouter["notes"]>> };
  };
}
declare const client: ForgeRpcClientOf<Rpc>;

export async function typed() {
  const sum: number = (await client.shop.add.query({ a: 1, b: 2 })).sum;
  const count: number = (await client.shop.notes.query()).count; // the method's return type
  const units: number = (await client.shop.order.mutate({ userId: "u", items: [{ sku: "a", qty: 1 }] })).units;
  return [sum, count, units];
}

export async function refused() {
  // @ts-expect-error .mutate is for mutations
  await client.shop.add.mutate({ a: 1, b: 2 });
  // @ts-expect-error .query is for queries
  await client.shop.order.query({ userId: "u", items: [] });
  // @ts-expect-error a is a number
  await client.shop.add.query({ a: "1", b: 2 });
  // @ts-expect-error add takes input
  await client.shop.add.query();
  // @ts-expect-error notes takes none
  await client.shop.notes.query({ x: 1 });
  // @ts-expect-error no router by that alias
  void client.billing;
}
