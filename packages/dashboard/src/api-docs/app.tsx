// The API docs page, as the engine serves it: reads its configuration from the HTML, loads the app's own pages and slots (forge/docs, compiled
// into the bundle by host.ts) and hydrates the page the server rendered (ssr.tsx), or renders it when the server couldn't. The same reference
// is the component for full-stack apps (react.tsx).
import { lazy, type ComponentType } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
// @ts-expect-error made by host.ts's build: the app's forge/docs pages and slots, each loaded when it is used
import content from "forge-docs:content";
import type { BootConfig } from "./boot";
import type { Guide, SlotName, Slots } from "./context";
import type { OpenApi } from "./openapi";
import { Reference } from "./reference";
import { makeTranslate } from "./strings";
import "./styles.css";

export { STRING_KEYS } from "./strings";

const boot = JSON.parse(document.getElementById("forge-docs-config")!.textContent!) as BootConfig;
const loaded = content as {
  guides: Guide[];
  slots: Partial<Record<SlotName, () => Promise<{ default: ComponentType<any> }>>>;
  components: Record<string, ComponentType<any>>;
  functionsGuide: Guide;
};

async function start() {
  const root = document.getElementById("root")!;
  const guides = loaded.guides.map((g) => ({ ...g }));
  const functionsGuide = { ...loaded.functionsGuide, title: makeTranslate(boot.page.strings)("functionsGuide") };
  // What the server rendered must be there when hydrating: the document it rendered with, the slots, and the guide the page shows.
  let doc: OpenApi | undefined;
  if (boot.rendered) {
    const url = `${boot.openapiUrl}${boot.rendered === "all" ? `${boot.openapiUrl.includes("?") ? "&" : "?"}audience=all` : ""}`;
    doc = await fetch(url).then((r) => (r.ok ? (r.json() as Promise<OpenApi>) : undefined)).catch(() => undefined);
  }
  const slots: Slots = {};
  const slotModules = await Promise.all(Object.entries(loaded.slots).map(async ([name, load]) => [name, doc ? (await load!()).default : lazy(load!)] as const));
  for (const [name, c] of slotModules) (slots as Record<string, unknown>)[name] = c;
  const shown = boot.path.startsWith("/guides/") ? [...guides, functionsGuide].find((g) => `/guides/${g.slug}` === boot.path) : undefined;
  if (doc && shown?.load) shown.content = (await shown.load()).default;
  const page = (
    <Reference
      document={doc}
      openapiUrl={boot.openapiUrl}
      publicBase={boot.publicBase}
      path={boot.path}
      config={boot.page}
      explorerUrl={boot.explorerUrl}
      tryOpen={boot.tryOpen}
      dev={boot.dev}
      guides={guides}
      functionsGuide={functionsGuide}
      slots={slots}
      components={loaded.components}
    />
  );
  if (doc && root.firstElementChild) hydrateRoot(root, page, { onRecoverableError: (e) => boot.dev && console.warn("The API docs page didn't hydrate cleanly:", e) });
  else createRoot(root).render(page);
}

void start();
