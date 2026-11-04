// What the build says about each page to readers that don't run JavaScript: the note under each link in llms.txt, the pages' meta descriptions,
// and the "start here by task" map. Not bundled into the app. Typed on `Slug`, so a page added to nav.ts fails the build until it is described here.
import type { Slug } from "./src/nav";

/** One or two sentences: what the page covers, and when to read it. */
export const DESCRIPTIONS: Record<Slug, string> = {
  introduction:
    "What archlast-forge is and how it compares: the engine, the two project modes, the packages. Read first to decide whether it fits.",
  concepts:
    "The mental model: which process runs your code, what a transaction covers, how live queries and the caches work. Read once before the rest.",
  "getting-started":
    "From nothing to a running project: create it, make a first change, open the dashboard, build for production. Both project modes.",
  tutorial:
    "Build a small notes app as a full-stack project, step by step: schema, functions, pages, live updates, auth.",
  framework:
    "Full-stack apps: file routes, loaders, server rendering, live queries in components, hydration rules, styling, NestJS in forge/.",
  backend:
    "Backends: the engine plus a container stack (Postgres, Redis, S3, Caddy), calling it from any frontend, NestJS, production checklist.",
  monorepo:
    "Turborepo monorepos and microservices: layout, shared types in packages/api and packages/contracts, add/remove/workspace commands, services calling services.",
  schema:
    "Tables, fields, validators (`v`), indexes, search indexes, relations. Read when modeling data.",
  functions:
    "Queries, mutations, actions and internal functions: arguments, return validators, ctx, auth checks, limits, what each kind may do.",
  transactions:
    "What a transaction is for a query, mutation, action and auth flow; atomicity, consistency, isolation and durability on SQLite, Postgres and MongoDB; what is not covered and how it is tested.",
  queries:
    "Everything on ctx.db: reads, indexes and ranges, filters, pagination, search, counts, joins, writes, performance notes.",
  reactivity:
    "How a subscribed query stays current: topics, re-runs, what makes a query cheap or expensive to keep live.",
  caching:
    "The query cache and the SQLite read cache: settings, what is safe to cache, how writes invalidate, measuring, gotchas.",
  errors:
    "The four ways a call fails, `ForgeError`, validation errors, what callers see in dev and production, and how to handle each in clients.",
  migrations:
    "How tables and indexes sync, the schema check, data migrations (`archlast-forge migrate`), export, import and backup.",
  auth: "Better Auth in the engine: sign-up and sign-in, sessions, roles, `ctx.auth`, plugins, social providers, dashboard accounts.",
  storage:
    "File uploads and downloads: S3-compatible or built-in local storage, presigned URLs, the upload flow from the client.",
  scheduling:
    "Scheduled functions and crons: `ctx.scheduler`, `forge/crons.ts`, exactly-once mutations versus at-most-once actions, cancelling and retrying.",
  webhooks:
    "Sending and receiving webhooks in one module on your own database: the outbox, Standard Webhooks signatures, retries and the attempt log, endpoints per tenant, verified inbound webhooks applied once.",
  http: "Plain HTTP endpoints in forge/http.ts: webhooks, public JSON APIs, downloads, validators, CORS, rate limits, streaming.",
  nest: "NestJS inside the engine: services with `ForgeService` and `inject()`, modules, controllers, gateways, GraphQL, microservice transports, folder layout.",
  "forge-rpc":
    "Typed calls between forge backends: `@Router` classes, generated types, the client service class, errors, tokens, moving from TCP.",
  "api-docs":
    "The generated OpenAPI 3.1 document and API docs page with a request explorer; writing your own docs pages.",
  clients:
    "The client library and the React, Vue and Svelte bindings: queries, mutations, uploads, auth, headers, calling the engine without the client.",
  mobile:
    "Expo (React Native) apps as clients of the main app: sign-in with Better Auth's Expo plugin, secure storage, live queries.",
  desktop:
    "Tauri desktop apps: `full` (the engine inside the app) or `client` (a page for a backend elsewhere).",
  testing:
    "Testing functions and services without a server (`createTestBackend`), auth and scheduled functions in tests, React components, testing a running app.",
  recipes:
    "Short complete answers to common needs: per-user data, infinite scroll, optimistic updates, search, uploads, webhooks, crons, rate limits, soft delete, workflows, feature flags.",
  "agent-skill":
    "The installable skill for AI coding agents (`npx skills add algochad/archlast-forge`), what it teaches and how to read these docs as Markdown.",
  cli: "Every `archlast-forge` command and flag: init, dev, build, up, codegen, migrate, export, import, backup, restore, env, admin, upgrade, monorepo, add, remove.",
  deployment:
    "Running in production: the Docker stack and image, other platforms, environment, health and shutdown, TLS and proxies, scaling out, logs and metrics, without Docker.",
  configuration:
    "Every engine environment variable and setting: defaults, what is env-only, what the dashboard can change live.",
  dashboard:
    "The admin dashboard: sign-in, roles, pages, editing data, running functions, the admin API, the audit log.",
  backups:
    "Full backups and restores: what is in an archive, schedules, S3 or folder stores, restoring into an empty or existing database.",
  observability:
    "Built-in tracing, issues, logs, SLOs and alerts; custom spans and metrics; OpenTelemetry ingest and export; one dashboard for a monorepo.",
  limits:
    "Every limit the engine enforces and what a caller sees at each, plus the security model and checklist.",
  convex:
    "How archlast-forge compares with Convex's self-hosted backend on one machine: cached and uncached reads, writes and live updates, with the setup and what it does not show.",
  reference:
    "Exact signatures of every public export of every package, the wire protocol and the HTTP surface.",
  troubleshooting:
    "Find the message or symptom, read the cause, apply the fix.",
  "release-notes":
    "What each release changed, newest first, with upgrade notes; Unreleased is what is on the staging branch.",
};

/** "Start here by task": a task and the pages to read for it, in order. */
export const TASKS: [task: string, pages: Slug[]][] = [
  ["Start a new project and run it", ["getting-started", "cli"]],
  [
    "Choose full-stack, backend, monorepo or microservices",
    ["framework", "backend", "monorepo"],
  ],
  ["Model data and write functions", ["schema", "functions", "queries"]],
  ["Make the UI live, and keep it fast", ["reactivity", "caching", "clients"]],
  [
    "Sign users in, store files, run work later",
    ["auth", "storage", "scheduling"],
  ],
  ["Add REST endpoints, services and controllers", ["http", "nest"]],
  ["Connect several backends", ["monorepo", "forge-rpc"]],
  ["Test it", ["testing"]],
  [
    "Deploy and operate it",
    ["deployment", "configuration", "backups", "dashboard", "observability"],
  ],
  ["Fix a failure", ["troubleshooting", "errors", "limits"]],
  ["See how it compares with Convex", ["convex"]],
  ["Look up an exact signature", ["reference"]],
];

/** A section's id, as in `/llms-<id>.txt`: "Project modes" is "project-modes". */
export const sectionId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
