// The pages in reading order, with their titles and loaders, and the sidebar's sections. Shared by the app and the build.
import type { Doc } from "./doc";

export const PAGES = {
  introduction: ["Introduction", () => import("../content/introduction.mdx")],
  concepts: ["How it works", () => import("../content/concepts.mdx")],
  "getting-started": ["Getting started", () => import("../content/getting-started.mdx")],
  tutorial: ["Tutorial: a notes app", () => import("../content/tutorial.mdx")],
  framework: ["Full-stack apps", () => import("../content/framework.mdx")],
  backend: ["Backends", () => import("../content/backend.mdx")],
  monorepo: ["Monorepos and microservices", () => import("../content/monorepo.mdx")],
  schema: ["Schema and validators", () => import("../content/schema.mdx")],
  functions: ["Functions", () => import("../content/functions.mdx")],
  transactions: ["Transactions and ACID", () => import("../content/transactions.mdx")],
  queries: ["Reading data", () => import("../content/queries.mdx")],
  reactivity: ["Reactivity", () => import("../content/reactivity.mdx")],
  caching: ["Caching", () => import("../content/caching.mdx")],
  errors: ["Errors", () => import("../content/errors.mdx")],
  migrations: ["Migrations and data", () => import("../content/migrations.mdx")],
  auth: ["Authentication", () => import("../content/auth.mdx")],
  storage: ["File storage", () => import("../content/storage.mdx")],
  scheduling: ["Scheduling and crons", () => import("../content/scheduling.mdx")],
  http: ["HTTP endpoints", () => import("../content/http.mdx")],
  webhooks: ["Webhooks", () => import("../content/webhooks.mdx")],
  nest: ["Controllers and services", () => import("../content/nest.mdx")],
  "forge-rpc": ["Forge RPC", () => import("../content/forge-rpc.mdx")],
  "api-docs": ["API docs and OpenAPI", () => import("../content/api-docs.mdx")],
  "security-headers": ["Security headers", () => import("../content/security-headers.mdx")],
  clients: ["Clients", () => import("../content/clients.mdx")],
  mobile: ["Mobile apps", () => import("../content/mobile.mdx")],
  desktop: ["Desktop apps", () => import("../content/desktop.mdx")],
  testing: ["Testing", () => import("../content/testing.mdx")],
  recipes: ["Recipes", () => import("../content/recipes.mdx")],
  "agent-skill": ["Agent skill", () => import("../content/agent-skill.mdx")],
  cli: ["CLI reference", () => import("../content/cli.mdx")],
  deployment: ["Deployment", () => import("../content/deployment.mdx")],
  configuration: ["Configuration", () => import("../content/configuration.mdx")],
  dashboard: ["Dashboard", () => import("../content/dashboard.mdx")],
  backups: ["Backups", () => import("../content/backups.mdx")],
  observability: ["Observability", () => import("../content/observability.mdx")],
  limits: ["Limits and security", () => import("../content/limits.mdx")],
  "tuyere": ["Tuyere: the Rust HTTP engine", () => import("../content/tuyere.mdx")],
  "rust-renderer": ["Crucible: Rust page rendering", () => import("../content/rust-renderer.mdx")],
  hearth: ["Hearth: the native database layer", () => import("../content/hearth.mdx")],
  "thread-pool": ["Anvil: the thread pool", () => import("../content/thread-pool.mdx")],
  benchmarks: ["Benchmarks", () => import("../content/benchmarks.mdx")],
  convex: ["Compared with Convex", () => import("../content/convex.mdx")],
  reference: ["API reference", () => import("../content/reference.mdx")],
  troubleshooting: ["Troubleshooting", () => import("../content/troubleshooting.mdx")],
  "release-notes": ["Release notes", () => import("../content/release-notes.mdx")],
} satisfies Record<string, [string, () => Promise<Doc>]>;
export type Slug = keyof typeof PAGES;

/** The sidebar's sections, in reading order. Every page in PAGES must be in exactly one. */
export const GROUPS: [string, Slug[]][] = [
  ["Start", ["introduction", "concepts", "getting-started", "tutorial"]],
  ["Project modes", ["framework", "backend", "monorepo"]],
  ["Data and functions", ["schema", "functions", "transactions", "queries", "reactivity", "caching", "errors", "migrations"]],
  ["Server features", ["auth", "storage", "scheduling", "http", "webhooks", "nest", "forge-rpc", "api-docs", "security-headers"]],
  ["Clients and guides", ["clients", "mobile", "desktop", "testing", "recipes", "agent-skill"]],
  ["Run", ["cli", "deployment", "configuration", "dashboard", "backups", "observability", "limits"]],
  ["Performance", ["tuyere", "rust-renderer", "hearth", "thread-pool", "benchmarks", "convex"]],
  ["Reference", ["reference", "troubleshooting", "release-notes"]],
];

export const reading = GROUPS.flatMap(([, slugs]) => slugs);
if (reading.length !== Object.keys(PAGES).length || Object.keys(PAGES).some((s) => reading.filter((g) => g === s).length !== 1)) throw new Error("GROUPS and PAGES list different pages");

export const isSlug = (s: string | undefined): s is Slug => s !== undefined && Object.hasOwn(PAGES, s);
export const titleOf = (slug: Slug) => PAGES[slug][0];
export const groupOf = (slug: Slug) => GROUPS.find(([, slugs]) => slugs.includes(slug))![0];

export const GITHUB = "https://github.com/algochad/archlast-forge";
export const NPM = "https://www.npmjs.com/org/archlast";
