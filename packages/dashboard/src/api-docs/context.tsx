// What the page's components share: the document, its arrangement, the strings, the credentials and the request builder's controls.
import { createContext, useContext, useSyncExternalStore, type ComponentType } from "react";
import type { AuthPreset, CodeSampleLanguage, DocsPageConfig } from "./contract";
import type { CredentialStore } from "./credentials";
import type { Arranged, OpEntry, OpenApi, Operation } from "./openapi";
import type { Site, Target } from "./site";
import { makeTranslate, type Translate } from "./strings";

export type SlotName = "header" | "sidebar-footer" | "operation-before" | "operation-after";
/** What an operation slot (forge/docs/_slots/operation-before.mdx, operation-after.mdx) receives as `props`. */
export interface OperationSlotProps {
  /** The operation as the document has it. */
  operation: Operation;
  path: string;
  /** Lowercase, as in the document: "get", "post". */
  method: string;
  /** The tag the operation is listed under. */
  tag: string;
}
export interface Slots {
  header?: ComponentType;
  "sidebar-footer"?: ComponentType;
  "operation-before"?: ComponentType<OperationSlotProps>;
  "operation-after"?: ComponentType<OperationSlotProps>;
}

/** A page of prose next to the reference: an MDX file of the app's forge/docs, or one the embedding app passes. */
export interface Guide {
  slug: string;
  title: string;
  group?: string;
  order?: number;
  /** Plain text, for search. */
  text?: string;
  /** The page itself, when the caller has it (it then renders on a server too), or how to load it when it is first shown. */
  content?: ComponentType;
  load?: () => Promise<{ default: ComponentType }>;
  /** Its file (forge/docs/…), for errors. */
  file?: string;
}

export interface DocContext {
  doc: OpenApi;
  model: Arranged;
  config: DocsPageConfig;
  t: Translate;
  /** The page's origin ("" while rendering on a server). */
  origin: string;
  openapiUrl: string | undefined;
  languages: CodeSampleLanguage[];
  /** The code sample tab the visitor picked, shared by every operation. */
  lang: Store<string | undefined>;
  slots: Slots;
  credentials: CredentialStore;
  preset: AuthPreset | undefined;
  authorize: () => void;
  tryIt: { enabled: boolean; open: (entry: OpEntry, opener: HTMLElement | null) => void; prefetch: () => void };
  /** The pages and where everything is. */
  site: Site;
  /** Where the page is as the browser sees it; links start with it. */
  publicBase: string;
  /** A target's link. */
  href: (target: Target | null | undefined) => string;
  /** Development: show what failed to build or render. */
  dev: boolean;
  /** The app's MDX components and the built-in ones, by name. */
  mdx: Record<string, ComponentType<any>>;
}

/** A value components read with useStore: changing it re-renders only them, not everything that reads the context. */
export class Store<T> {
  constructor(private value: T) {}
  private listeners = new Set<() => void>();
  get = () => this.value;
  set = (value: T) => {
    if (value === this.value) return;
    this.value = value;
    for (const l of this.listeners) l();
  };
  subscribe = (l: () => void) => (this.listeners.add(l), () => void this.listeners.delete(l));
}
export const useStore = <T,>(store: Store<T>): T => useSyncExternalStore(store.subscribe, store.get, store.get);

const Ctx = createContext<DocContext | null>(null);
export const DocProvider = Ctx.Provider;
export function useDoc(): DocContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("outside the API reference");
  return c;
}
export const useT = () => useContext(Ctx)?.t ?? defaultT;
/** The context, or null outside the reference (a page that has no document yet). */
export const useDocSafe = () => useContext(Ctx);
const defaultT = makeTranslate();
