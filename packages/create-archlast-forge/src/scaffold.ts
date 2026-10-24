// Writes a new project from the templates.
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nameOf } from "./options";
import {
  DOCKERIGNORE,
  generateSecrets,
  renderCaddyfile,
  renderCompose,
  renderDockerfile,
  renderEnv,
  type Mode,
  type StackService,
} from "./stack";

const TEMPLATE = new URL("../template", import.meta.url).pathname;
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export interface ScaffoldOptions {
  dir: string;
  mode: Mode;
  services: StackService[];
  /** The archlast-forge version the project depends on. Defaults to this package's. */
  version?: string;
}

/** Writes a new project into `dir` (which may exist but must be empty) and returns its absolute path. */
export function scaffold({ dir, mode, services, version = VERSION }: ScaffoldOptions): string {
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} isn't empty`);
  const name = nameOf(target);
  for (const part of ["base", mode]) cpSync(join(TEMPLATE, part), target, { recursive: true });
  renameSync(join(target, "gitignore"), join(target, ".gitignore")); // npm drops .gitignore files from packages
  if (services.includes("s3")) cpSync(join(TEMPLATE, "extras", "files.ts"), join(target, "forge", "files.ts")); // something that uses the storage

  const fill = (path: string) => {
    for (const entry of readdirSync(path)) {
      const p = join(path, entry);
      if (statSync(p).isDirectory()) fill(p);
      else writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__VERSION__", version));
    }
  };
  fill(target);

  const write = (file: string, text: string, secret = false) => {
    writeFileSync(join(target, file), text);
    if (secret) chmodSync(join(target, file), 0o600);
  };
  write("archlast-forge.json", JSON.stringify({ mode, services }, null, 2) + "\n");
  write("Dockerfile", renderDockerfile(version));
  write(".dockerignore", DOCKERIGNORE);
  write("compose.yaml", renderCompose({ name, services, version }));
  write(".env.example", renderEnv(services));
  write(".env", renderEnv(services, generateSecrets()), true);
  if (services.includes("caddy")) write("Caddyfile", renderCaddyfile(services));
  return target;
}
