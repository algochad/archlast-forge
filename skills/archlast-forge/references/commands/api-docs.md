# Command: `api-docs [public]`

Turns the app's REST API into a documented public reference: `http.docs({...})` once in `forge/http.ts`, validators that carry the constraints, and every documented route with its summary, tags, errors and security. `public` also serves it in production. Example: `/archlast-forge api-docs public`.

## 1. Before you write

1. Read [server-features.md](../server-features.md) "API docs and OpenAPI" and, for Nest controllers, `@Contract` in [nest-services.md](../nest-services.md).
2. Inventory what is served: `bun run dev`, then `curl -s 'localhost:3000/_api/openapi.json?audience=all'` (or the project's docs path) lists every operation. Note the routes with no `summary`, `tags` or `returns` (dev also warns about them in the log).
3. Ask who the reader is (partners, mobile team, the public) and what they may see: that sets `include` (path prefixes), `functions: false` (leave `/rpc` out of a REST reference), and `production`.

## 2. Steps

1. **`http.docs({...})`** once in `forge/http.ts`: `info` (title, version, description), `include`, `functions`, `securitySchemes` + `security` for how callers authenticate, `errors` (the error body as a named `v.object`, and `common` codes), `tags` with descriptions, `production: true` only with `public`.
2. **Routes**: every documented `http.route()` and `@Contract()` gets `summary`, `tags`, `returns`, the stable error codes it answers (`errors: { 404: "invoice_not_found" }`), and `security` with scopes where it differs. Inbound webhooks and internal routes get `hidden: true` / `@ApiHidden()`.
3. **Validators**: bounds and formats in the validators (`v.string({ maxLength, format: "email" })`, `v.number({ int: true, min })`, `v.enum(...)`), `description` and `example` on fields readers need, and `name` on bodies that appear more than once (`v.object({...}, { name: "Invoice" })`) so they become one model.
4. **Guides**: `forge/docs/*.mdx` with front matter (`title`, `group`, `order`) for getting started, authentication and errors; slots in `forge/docs/_slots/` only if asked.
5. `bun run codegen && bun run typecheck`.

## 3. Verify

- `curl -s localhost:3000/<path>/openapi.json` (the public audience) has exactly the operations meant for the reader, each with a `summary`; no internal or hidden route appears; named schemas are under `components.schemas`.
- The page `/<path>` renders and "Try it" sends a request.
- With `public`: `NODE_ENV=production` start (or `up`) serves it; without, it is dev only.
- No page or root route clashes with the docs' paths (the engine logs it in dev and refuses in production).

## 4. Report

```
API docs at /<path> (document /<path>/openapi.json), audience: <include>, production: yes|no
  operations: N documented · named models: … · guides: …
  still missing a summary/tags/returns: … (none)
Checks: document reviewed · page renders · Try it works
```

## 5. Stop and ask when

- the reference would expose internal endpoints or `/rpc` functions to an outside audience;
- a security scheme or token URL is unclear (do not guess how partners authenticate);
- serving in production is implied but not asked.

## Full documentation

| Page                                                                                                        | Read it for                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [api-docs](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/api-docs.mdx) | `http.docs()`, route documentation, guides, slots, the page         |
| [schema](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/schema.mdx)     | constraints and documentation on validators, named schemas          |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)         | `@Contract`, `@ApiSecurity`, `@ApiHidden`                           |
