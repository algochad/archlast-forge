// The pages in reading order, with their titles and loaders, and the sidebar's sections. Shared by the app and the build.
import type { Doc } from "./doc";

export const PAGES = {
  introduction: ["Introduction", () => import("../content/introduction.mdx")],
  concepts: ["How it works", () => import("../content/concepts.mdx")],
  "getting-started": ["Getting started", () => import("../content/getting-started.mdx")],
  tutorial: ["Tutorial: a notes app", () => import("../content/tutorial.mdx")],
  framework: ["Full-stack apps", () => import("../content/framework.mdx")],
  backend: ["Backends", () => import("../content/backend.mdx")],
  schema: ["Schema and validators", () => import("../content/schema.mdx")],
  functions: ["Functions", () => import("../content/functions.mdx")],
  queries: ["Reading data", () => import("../content/queries.mdx")],
  reactivity: ["Reactivity", () => import("../content/reactivity.mdx")],
  caching: ["Caching", () => import("../content/caching.mdx")],
  errors: ["Errors", () => import("../content/errors.mdx")],
  migrations: ["Migrations and data", () => import("../content/migrations.mdx")],
  auth: ["Authentication", () => import("../content/auth.mdx")],
  storage: ["File storage", () => import("../content/storage.mdx")],
  scheduling: ["Scheduling and crons", () => import("../content/scheduling.mdx")],
  http: ["HTTP endpoints", () => import("../content/http.mdx")],
  nest: ["NestJS", () => import("../content/nest.mdx")],
  clients: ["Clients: React, Vue, Svelte", () => import("../content/clients.mdx")],
  testing: ["Testing", () => import("../content/testing.mdx")],
  recipes: ["Recipes", () => import("../content/recipes.mdx")],
  cli: ["CLI reference", () => import("../content/cli.mdx")],
  deployment: ["Deployment", () => import("../content/deployment.mdx")],
  configuration: ["Configuration", () => import("../content/configuration.mdx")],
  dashboard: ["Dashboard", () => import("../content/dashboard.mdx")],
  observability: ["Observability", () => import("../content/observability.mdx")],
  limits: ["Limits and security", () => import("../content/limits.mdx")],
  reference: ["API reference", () => import("../content/reference.mdx")],
  troubleshooting: ["Troubleshooting", () => import("../content/troubleshooting.mdx")],
} satisfies Record<string, [string, () => Promise<Doc>]>;
export type Slug = keyof typeof PAGES;

/** The sidebar's sections, in reading order. Every page in PAGES must be in exactly one. */
export const GROUPS: [string, Slug[]][] = [
  ["Start", ["introduction", "concepts", "getting-started", "tutorial"]],
  ["Project modes", ["framework", "backend"]],
  ["Data and functions", ["schema", "functions", "queries", "reactivity", "caching", "errors", "migrations"]],
  ["Server features", ["auth", "storage", "scheduling", "http", "nest"]],
  ["Clients and guides", ["clients", "testing", "recipes"]],
  ["Run", ["cli", "deployment", "configuration", "dashboard", "observability", "limits"]],
  ["Reference", ["reference", "troubleshooting"]],
];

export const reading = GROUPS.flatMap(([, slugs]) => slugs);
if (reading.length !== Object.keys(PAGES).length || Object.keys(PAGES).some((s) => reading.filter((g) => g === s).length !== 1)) throw new Error("GROUPS and PAGES list different pages");

export const isSlug = (s: string | undefined): s is Slug => s !== undefined && Object.hasOwn(PAGES, s);
export const titleOf = (slug: Slug) => PAGES[slug][0];
export const groupOf = (slug: Slug) => GROUPS.find(([, slugs]) => slugs.includes(slug))![0];

export const GITHUB = "https://github.com/algochad/archlast-forge";
export const NPM = "https://www.npmjs.com/org/archlast";
