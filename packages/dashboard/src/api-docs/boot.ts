// What host.ts writes into the page's HTML (`<script type="application/json" id="forge-docs-config">`) for app.tsx to read.
import type { DocsPageConfig } from "./contract";

export interface BootConfig {
  /** Where the page is as the browser sees it; assets and links start with it. */
  publicBase: string;
  /** The OpenAPI document's URL as the browser sees it. */
  openapiUrl: string;
  /** The request builder's script, or null when "Try it" is off. */
  explorerUrl: string | null;
  /** The page was asked for at the explorer path: open the request builder on load (`?op=<operationId>` picks the operation). */
  tryOpen: boolean;
  dev: boolean;
  page: DocsPageConfig;
  /** The page shown, below `publicBase` ("" for the overview). */
  path: string;
  /** The HTML is the page, rendered on the server with the document of this audience: the browser hydrates it with the same document. */
  rendered?: "public" | "all";
}
