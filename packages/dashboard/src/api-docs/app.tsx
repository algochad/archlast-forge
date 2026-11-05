// The API docs page, as the engine serves it: reads its configuration from the HTML, loads the app's own pages and slots (forge/docs, compiled
// into the bundle by host.ts) and mounts the reference. The same reference is the component for full-stack apps (react.tsx).
import { lazy, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error made by host.ts's build: the app's forge/docs pages and slots, each loaded when it is used
import content from "forge-docs:content";
import type { BootConfig } from "./boot";
import type { Guide, SlotName, Slots } from "./context";
import { Reference } from "./reference";
import { makeTranslate } from "./strings";
import "./styles.css";

export { STRING_KEYS } from "./strings";

const boot = JSON.parse(document.getElementById("forge-docs-config")!.textContent!) as BootConfig;
const { guides, slots: slotLoaders } = content as { guides: Guide[]; slots: Partial<Record<SlotName, () => Promise<{ default: ComponentType<any> }>>> };

const slots: Slots = {};
for (const [name, load] of Object.entries(slotLoaders)) (slots as Record<string, unknown>)[name] = lazy(load!);

const functionsGuide: Guide = {
  slug: "functions",
  title: makeTranslate(boot.page.strings)("functionsGuide"),
  text: "Call the engine's functions over HTTP at /rpc/<module>:<name> and keep a query live over the WebSocket at /rpc.",
  load: () => import("./guide.mdx"),
};

createRoot(document.getElementById("root")!).render(
  <Reference
    openapiUrl={boot.openapiUrl}
    publicBase={boot.publicBase}
    config={boot.page}
    explorerUrl={boot.explorerUrl}
    tryOpen={boot.tryOpen}
    dev={boot.dev}
    guides={guides}
    functionsGuide={functionsGuide}
    slots={slots}
  />,
);
