// Page templates printed in Rust (see crates/core/src/template.rs): register one by name, print it with JSON data.
// A template is registered with the binding the server runs on (ARCHLAST_BACKEND; each has a registry of its own).
import { defaultBackend, getBackend } from "./backend.ts";

const templates = () => getBackend(defaultBackend()).templates;

/** Registers (or replaces) a template; returns its id. */
export const registerTemplate = (name: string, template: unknown): number => templates().register(name, JSON.stringify(template));

/** The page: template `id` printed with `data` as its variable `d`. */
export const renderTemplate = (id: number, data: unknown): string => templates().render(id, typeof data === "string" ? data : JSON.stringify(data));
