import { anyApi } from "@archlast-forge/runtime";
import { startServer } from "@archlast-forge/runtime/server";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, effectScope, nextTick } from "vue";
import { ArchlastForgeClient, archlastForge, useMutation, useQuery } from "../src/index";

const api = anyApi;
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 1000 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

test("useQuery is live and stops with its scope", async () => {
  const srv = await startServer({ forgeDir: join(import.meta.dir, "../../runtime/test/fixture"), dev: true, env: { ...process.env, PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "afx-vue-")) } });
  const client = new ArchlastForgeClient({ url: srv.url });
  const app = createApp({}).use(archlastForge(client));
  const scope = effectScope();
  const { events, add } = app.runWithContext(() => scope.run(() => ({ events: useQuery(api.todos.events), add: useMutation(api.todos.logEvent) }))!);
  await until(() => Array.isArray(events.data.value));
  expect(events.data.value).toEqual([]);
  await add({ kind: "vue" });
  await until(() => (events.data.value as any[]).length === 1);
  scope.stop();
  await nextTick();
  client.close();
  await srv.stop();
}, 30_000); // starts a real server
