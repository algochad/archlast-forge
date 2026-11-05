// The API reference as a component for full-stack apps: render the generated reference inside the app's own layout, navigation and theme.
//
//   import "@archlast/forge-dashboard/api-docs/styles.css";
//   import { ApiReference } from "@archlast/forge-dashboard/api-docs/react";
//   <ApiReference openapiUrl="/_api/openapi.json" config={{ theme: { accent: "#0a7" } }} />
//
// It renders on a server (pass `document` and the HTML is the whole reference) and hydrates in the browser. Its styles are scoped to the
// component (`.fd`), so they don't touch the rest of the page. "Try it" loads the request builder from `explorerUrl` the first time it is used.
import type { ComponentType } from "react";
import type { DocsPageConfig } from "./contract";
import type { Guide, OperationSlotProps, Slots } from "./context";
import type { OpenApi } from "./openapi";
import { Reference } from "./reference";

export type { DocsPageConfig, Guide, OpenApi, OperationSlotProps, Slots };

export interface ApiReferenceProps {
  /** Where the OpenAPI document is, as the browser sees it (the engine serves it at `<docs path>/openapi.json`). */
  openapiUrl?: string;
  /** The document itself, when the app has it (a loader's data): rendered at once, also on a server, and nothing is fetched. */
  document?: OpenApi;
  config?: DocsPageConfig;
  /** The request builder's script: the engine serves it at `<docs path>/_docs/explorer.js`, which is where this points by default. `null` turns "Try it" off. */
  explorerUrl?: string | null;
  /** Pages of prose shown before the reference, in the navigation. */
  guides?: { slug: string; title: string; group?: string; order?: number; content: ComponentType }[];
  slots?: Slots;
  className?: string;
}

const DEFAULT_EXPLORER = "/_api/_docs/explorer.js";

export function ApiReference({ openapiUrl, document, config, explorerUrl = DEFAULT_EXPLORER, guides, slots, className }: ApiReferenceProps) {
  const pages: Guide[] | undefined = guides?.map((g) => ({ slug: g.slug, title: g.title, group: g.group, order: g.order, content: g.content }));
  return <Reference embed openapiUrl={openapiUrl} document={document} config={config} explorerUrl={explorerUrl} guides={pages} slots={slots} className={className} publicBase={openapiUrl} />;
}
