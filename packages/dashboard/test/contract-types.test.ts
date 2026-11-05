// The engine (packages/runtime) and the page (this package) each declare the page's configuration, since neither depends on the other: they
// must stay the same type, or a field the app sets would be dropped on the way. A type-only import of the runtime's source checks it.
import { expect, test } from "bun:test";
import type { ApiDocsPageConfig } from "../../runtime/src/api-docs";
import type { DocsPageConfig } from "../src/api-docs/contract";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<ApiDocsPageConfig, DocsPageConfig> = true;

test("the engine's page config and the page's are one type", () => {
  expect(same).toBe(true);
});
