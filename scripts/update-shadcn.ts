#!/usr/bin/env bun
// Refreshes the shadcn/ui files the scaffolder ships (packages/create-archlast-forge/template/shadcn) from the shadcn registry:
// the theme variables of every base color, and the source of the components the starter uses. Run it, review the diff, commit.
//   bun scripts/update-shadcn.ts
// The style is `base-nova` (what `shadcn init` picks by default today). Add a component by adding its name below, and import it from the starter.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BASE_COLORS } from "../packages/create-archlast-forge/src/shadcn";

const STYLE = "base-nova";
const COMPONENTS = ["avatar", "button", "card", "input", "label"];
const REGISTRY = "https://ui.shadcn.com/r";
const OUT = join(import.meta.dir, "..", "packages", "create-archlast-forge", "template", "shadcn");

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${REGISTRY}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
};
const write = (file: string, text: string) => (mkdirSync(dirname(join(OUT, file)), { recursive: true }), writeFileSync(join(OUT, file), text));

// The theme of each base color, in the form `shadcn init` writes into the CSS file (the Tailwind v4 variables).
const colors: Record<string, unknown> = {};
for (const name of BASE_COLORS) {
  const { cssVarsV4 } = await get<{ cssVarsV4: { light: Record<string, string>; dark: Record<string, string> } }>(`colors/${name}.json`);
  colors[name] = cssVarsV4;
}
write("colors.json", JSON.stringify(colors, null, 2) + "\n");

// Components, with the registry's own import paths turned into the project's (`@/components/ui`, `@/lib/utils`).
type Item = { dependencies?: string[]; registryDependencies?: string[]; files: { path: string; content: string }[] };
const dependencies = new Set<string>();
for (const name of [...COMPONENTS, "utils"]) {
  const item = await get<Item>(`styles/${STYLE}/${name}.json`);
  item.dependencies?.forEach((d) => dependencies.add(d));
  for (const dep of item.registryDependencies ?? []) if (!COMPONENTS.includes(dep) && dep !== "utils") throw new Error(`${name} needs ${dep}: add it to COMPONENTS`);
  for (const file of item.files) {
    const text = file.content.replaceAll(`@/registry/${STYLE}/ui/`, "@/components/ui/").replaceAll(`@/registry/${STYLE}/lib/`, "@/lib/");
    if (text.includes("@/registry")) throw new Error(`${file.path} still imports from the registry`);
    write(`app/${file.path.startsWith(`registry/${STYLE}/ui/`) ? "components/ui" : "lib"}/${file.path.split("/").pop()}`, text);
  }
}
console.log(`wrote ${COMPONENTS.length} components, utils and ${BASE_COLORS.length} base colors to ${OUT}`);
console.log("packages they import:", [...dependencies].sort().join(", "));
