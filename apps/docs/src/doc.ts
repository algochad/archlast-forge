import type { ComponentType } from "react";

/** A heading's text, with inline code kept apart so the outline can style it. */
export type Heading = { depth: number; id: string; parts: (string | { code: string })[] };

/** What importing a page gives: the content, and the headings the build collected from it. */
export type Doc = { default: ComponentType<{ components?: Record<string, ComponentType<any>> }>; headings: Heading[] };
