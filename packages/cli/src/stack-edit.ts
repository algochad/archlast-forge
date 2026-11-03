// Changing which services a project's stack has (PostgreSQL, Redis, S3 storage, Caddy), after `init` chose them: archlast-forge.json, and the
// compose.yaml, .env and Caddyfile that follow from it. Files the user has edited are never overwritten: the new version goes next to them.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nameOf } from "create-archlast-forge/options";
import { formatText, VERSION } from "create-archlast-forge/scaffold";
import { generateSecrets, parseProjectConfig, renderCaddyfile, renderCompose, renderEnv, SERVICES, type StackService } from "create-archlast-forge/stack";

export interface StackChange {
  services: StackService[];
  summary: string[];
  notes: string[];
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

/**
 * Adds and removes stack services in the project at `root` (the folder with archlast-forge.json). compose.yaml, .env.example and the Caddyfile are
 * written again only if they are what the old services would have made; otherwise the new compose.yaml is written as compose.new.yaml. .env
 * only gets the keys the new services need, with fresh secrets: the values you have are never touched.
 */
export function changeStack(root: string, o: { add?: StackService[]; remove?: StackService[] }): StackChange {
  root = resolve(root);
  const configFile = join(root, "archlast-forge.json");
  const configText = read(configFile);
  if (configText === undefined) throw new Error(`No archlast-forge.json in ${root}: run this in a project made by \`archlast-forge init\` (in a monorepo, inside one of its apps).`);
  const config = parseProjectConfig(JSON.parse(configText), configFile);
  const add = (o.add ?? []).filter((s) => !config.services.includes(s));
  const remove = (o.remove ?? []).filter((s) => config.services.includes(s));
  for (const s of [...(o.add ?? []), ...(o.remove ?? [])]) if (!(s in SERVICES)) throw new Error(`Unknown service "${s}". Choose from ${Object.keys(SERVICES).join(", ")}.`);
  if (!add.length && !remove.length) throw new Error(`Nothing to change: the stack has ${config.services.join(", ") || "no services"}.`);
  const services = [...config.services.filter((s) => !remove.includes(s)), ...add];
  const summary: string[] = [];
  const notes: string[] = [];

  // compose.yaml: the old services' version of it, formatted as the scaffold's was, tells whether it is still the generated one.
  const composeFile = join(root, "compose.yaml");
  const compose = read(composeFile);
  if (compose !== undefined) {
    const name = /^name: (\S+)$/m.exec(compose)?.[1] ?? nameOf(root);
    const version = /archlast-forge-engine:([0-9][^\s}"]*)/.exec(compose)?.[1] ?? VERSION;
    const was = formatText(root, "compose.yaml", renderCompose({ name, services: config.services, version }));
    const now = formatText(root, "compose.yaml", renderCompose({ name, services, version }));
    // Also the version before it passed OTEL_SERVICE_NAME and REDIS_PREFIX on: an unedited older file is still the generated one.
    const older = was.split("\n").filter((l) => !/^\s+(OTEL_SERVICE_NAME|REDIS_PREFIX): /.test(l)).join("\n");
    if (compose === was || compose === older) (writeFileSync(composeFile, now), summary.push("compose.yaml: written for the new services"));
    else
      (writeFileSync(join(root, "compose.new.yaml"), now),
        notes.push("compose.yaml has edits of yours, so it is unchanged. What the new services need is in compose.new.yaml: merge it by hand, and delete the file."));
  } else notes.push("There is no compose.yaml here (an older project): `archlast-forge up` needs one, and `init` makes it.");

  // .env gets only the keys that are missing, never a changed value.
  const envFile = join(root, ".env");
  const have = read(envFile);
  if (have !== undefined) {
    const wanted = renderEnv(services, generateSecrets())
      .split("\n")
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l) && !new RegExp(`^${l.slice(0, l.indexOf("="))}=`, "m").test(have));
    if (wanted.length)
      (appendFileSync(envFile, `\n# Added by \`archlast-forge stack\`\n${wanted.join("\n")}\n`), summary.push(`.env: ${wanted.map((l) => l.slice(0, l.indexOf("="))).join(", ")} added`));
  }
  const example = join(root, ".env.example");
  if (read(example) === renderEnv(config.services)) writeFileSync(example, renderEnv(services));

  // The Caddyfile: written when Caddy is added, and again when what it proxies (S3) changes, if it is still the generated one.
  const caddyFile = join(root, "Caddyfile");
  const caddy = read(caddyFile);
  if (services.includes("caddy")) {
    if (caddy === undefined) (writeFileSync(caddyFile, renderCaddyfile(services)), summary.push("Caddyfile: written"));
    else if (caddy === renderCaddyfile(config.services)) writeFileSync(caddyFile, renderCaddyfile(services));
  } else if (caddy !== undefined && caddy === renderCaddyfile(config.services)) (rmSync(caddyFile), summary.push("Caddyfile: deleted"));

  writeFileSync(configFile, JSON.stringify({ ...config, services }, null, /^[ \t]+(?=")/m.exec(configText)?.[0] ?? 2) + "\n");
  summary.unshift(`archlast-forge.json: ${services.join(", ") || "no services"}`);

  if (add.includes("postgres") || remove.includes("postgres"))
    notes.push("Documents in the old database are not moved: `archlast-forge export <file>` before the change, and `import <file>` once the new stack is up.");
  if (add.includes("caddy")) notes.push("Caddy serves https on your domain: set DOMAIN, and BETTER_AUTH_URL=https://<your domain>, in .env, and remove ALLOW_INSECURE_HTTP there.");
  if (remove.includes("caddy")) notes.push("Without Caddy the app answers on its own port: BETTER_AUTH_URL in .env must be the address people use.");
  if (remove.length) notes.push(`The volumes of ${remove.join(", ")} stay in Docker until \`archlast-forge down --volumes\`.`);
  return { services, summary, notes };
}
