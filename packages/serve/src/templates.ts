// Page templates printed in Rust (see crates/core/src/template.rs): register one by name, print it with JSON data. Node-API backend only.
import { nativePath } from "./paths.ts";

interface Addon {
  registerTemplate(name: string, json: string): number;
  renderTemplate(id: number, data: string): string;
}
let addon: Addon | undefined;
const load = () => (addon ??= require(nativePath("archlast_serve.node")) as Addon);

/** Registers (or replaces) a template; returns its id. */
export const registerTemplate = (name: string, template: unknown): number => load().registerTemplate(name, JSON.stringify(template));

/** The page: template `id` printed with `data` as its variable `d`. */
export const renderTemplate = (id: number, data: unknown): string => load().renderTemplate(id, typeof data === "string" ? data : JSON.stringify(data));
