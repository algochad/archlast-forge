// The page rendered on the server: host.ts builds this for Bun (with the app's forge/docs pages, slots and components imported as they are,
// not lazily) and calls render() for every page it answers. The browser then hydrates the same tree (app.tsx), so the HTML is the page.
import type { ComponentType } from "react";
import { renderToReadableStream } from "react-dom/server";
// @ts-expect-error made by host.ts's build: the app's forge/docs pages, slots and components, imported as they are
import content from "forge-docs:content";
import type { BootConfig } from "./boot";
import type { Guide, SlotName, Slots } from "./context";
import type { OpenApi } from "./openapi";
import { Reference } from "./reference";
import { makeTranslate } from "./strings";

const { guides, slots, components, functionsGuide } = content as {
  guides: Guide[];
  slots: Partial<Record<SlotName, ComponentType<any>>>;
  components: Record<string, ComponentType<any>>;
  functionsGuide: Guide;
};

export interface RenderInput {
  boot: BootConfig;
  document: OpenApi;
}

/** The reference's HTML for one page, every part of it rendered (nothing left to stream in). */
export async function render({ boot, document }: RenderInput): Promise<string> {
  const functions = { ...functionsGuide, title: makeTranslate(boot.page.strings)("functionsGuide") };
  const stream = await renderToReadableStream(
    <Reference
      document={document}
      openapiUrl={boot.openapiUrl}
      publicBase={boot.publicBase}
      path={boot.path}
      config={boot.page}
      explorerUrl={boot.explorerUrl}
      tryOpen={boot.tryOpen}
      dev={boot.dev}
      guides={guides}
      functionsGuide={functions}
      slots={slots as Slots}
      components={components}
    />,
    { onError: (e) => console.error(`The API docs page didn't render on the server: ${(e as Error)?.message ?? e}`) },
  );
  await stream.allReady;
  return new Response(stream).text();
}
