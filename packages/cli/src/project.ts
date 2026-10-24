import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseProjectConfig, type ProjectConfig } from "create-archlast-forge/stack";

export type { ProjectConfig };

/** The directory that holds forge/ (and app/, compose.yaml, ...). */
export const projectRoot = (forgeDir: string) => (["forge", "convex"].includes(basename(forgeDir)) ? dirname(forgeDir) : forgeDir);

/** archlast-forge.json, or undefined for a project from before it existed (those behave as a backend with no services). */
export function loadProjectConfig(forgeDir: string): ProjectConfig | undefined {
  const file = join(projectRoot(forgeDir), "archlast-forge.json");
  if (!existsSync(file)) return undefined;
  try {
    return parseProjectConfig(JSON.parse(readFileSync(file, "utf8")), file);
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `${file} isn't valid JSON: ${e.message}` : (e as Error).message);
  }
}
