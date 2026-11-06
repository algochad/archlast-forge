# Command: `service <name> [what it owns]`

Adds a microservice to a monorepo and gives it a real job: its own app in `apps/<name>`, its data, the Forge RPC router other apps call, and the main app's typed caller. Example: `/archlast-forge service billing "invoices and payments; the shop asks it to charge an order"`.

## 1. Before you write

1. Find the monorepo: `archlast-forge.workspace.json` at the root (`archlast-forge workspace` prints the apps, ports and transport). Not a monorepo? Propose `archlast-forge monorepo --microservices <name> --dry-run` (it moves the project into `apps/web` or `apps/api`) and wait for a yes.
2. Read [forge-rpc.md](../forge-rpc.md) and [project-modes.md](../project-modes.md) (monorepo layout, what `add service` writes).
3. Decide with the user what the service **owns** (its tables are private to it: no other app reads them) and which calls the other apps make (each one becomes a router procedure). A service that only forwards to another is not worth one.

## 2. Steps

1. `archlast-forge add service <name>` from anywhere in the monorepo. It writes `apps/<name>` (a backend with a starter router), the main app's `<name>.service.ts`, `<name>.controller.ts`, `<name>.ts` and `_services.ts`, `packages/contracts`, the shared token and the dashboard variables, and installs. Read its summary.
2. In `apps/<name>/forge/`: its features by [feature.md](feature.md) (tables, `_modules/<feature>/`, functions; the procedures' writes are `internalMutation`s).
3. The router `forge/<name>.router.ts` (top level, not `_modules/`): one `@Query`/`@Mutation` per call, with zod `input` and `output`, each calling the service's functions through `@Ctx()` (`ctx.runQuery`/`ctx.runMutation`). Remove the starter `hello` procedure and its `calls` table once the real ones exist, and the main app's `hello` controller and action with them.
4. `bun run codegen` in `apps/<name>` (writes `forge/_generated/rpc.ts`, shared by `packages/contracts`), then in the main app.
5. The main app calls it only through `forge/<name>.service.ts` (the CLI's class): add a method per call there, typed by the contract, and use that class from the main app's own services.
6. `bun run typecheck` at the root, tests in the service (`createTestBackend` on its functions) and in the main app.

## 3. Verify

- `bun run typecheck` at the monorepo root passes.
- `bun run dev` at the root starts every app; call the main app's route or action that uses the service and check the answer (`curl -s -X POST localhost:3000/rpc/<fn> -H 'content-type: application/json' -d '{...}'`).
- The service refuses a call without `FORGE_RPC_TOKEN` (call its RPC port with `curl` and no token: 401).
- The main app's dashboard lists the service (Microservices page).

## 4. Report

```
Service <name> (apps/<name>, port …, Forge RPC …)
  owns: tables …            router: <name>.a, <name>.b (input → output)
  main app calls it from:   <Name>Service.a(), used by …
Checks: typecheck (root) · tests · a call through the main app · token refused without it
Deploying: each app is its own stack (`bun run up` in apps/<name> and in the main app); see forge-rpc.md for the production addresses.
```

## 5. Stop and ask when

- the service would read another app's tables (it must call that app instead);
- the change needs a transport other than the workspace's (`forge-rpc`, `tcp`, `redis`, `nats` are fixed per monorepo);
- removing the starter `hello` would break a client someone uses.

## Full documentation

| Page                                                                                                          | Read it for                                                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [forge-rpc](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/forge-rpc.mdx) | routers, the typed client, the token, errors, batching        |
| [monorepo](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/monorepo.mdx)   | `add service`, `packages/contracts`, one dashboard, transports |
| [cli](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/cli.mdx)             | `add`, `remove`, `workspace`                                  |
