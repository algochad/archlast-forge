import { migration } from "../../src/index";

export const renameOldEvents = migration({
  table: "events",
  batchSize: 40,
  migrateOne: (_ctx, doc) => (doc.kind === "old" ? { kind: "new" } : undefined),
});

export const failOnPoison = migration({
  table: "events",
  migrateOne: (_ctx, doc) => {
    if (doc.kind === "poison" && !globalThis.process?.env?.CURE) throw new Error("poisoned");
  },
});
