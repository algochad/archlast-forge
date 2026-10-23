import { anyApi } from "@archlast-forge/runtime";
import { startServer } from "@archlast-forge/runtime/server";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchlastForgeClient, query } from "../src/index";

const api = anyApi;

test("query() is a live store that closes with its last subscriber", async () => {
  const srv = await startServer({ forgeDir: join(import.meta.dir, "../../runtime/test/fixture"), dev: true, env: { ...process.env, PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "afx-svelte-")) } });
  const client = new ArchlastForgeClient({ url: srv.url });
  const store = query(client, api.todos.events);
  const seen: any[] = [];
  const unsubscribe = store.subscribe((s) => seen.push(s));
  expect(seen[0]).toEqual({ data: undefined, error: undefined, isLoading: true });
  for (let i = 0; i < 1000 && !Array.isArray(seen.at(-1).data); i++) await Bun.sleep(10);
  await client.mutation(api.todos.logEvent, { kind: "svelte" });
  for (let i = 0; i < 1000 && seen.at(-1).data?.length !== 1; i++) await Bun.sleep(10);
  expect(seen.at(-1).data).toMatchObject([{ kind: "svelte" }]);
  unsubscribe();
  client.close();
  await srv.stop();
}, 30_000); // starts a real server
