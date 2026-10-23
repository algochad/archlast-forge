// What codegen writes to forge/_generated/dataModel.ts.
import type schema from "./schema";

declare module "../src/index" {
  interface Register {
    schema: typeof schema;
  }
}
