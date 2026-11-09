# The benchmark's API on the engine image with the items in the engine's own database, ctx.db on SQLite (build context: benchmarks/rest).
ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.17.0
FROM ${ENGINE_IMAGE}
ARG SERVER=forge-sqlite
COPY servers/${SERVER} /src
# the API's rules (a valid body, `limit`, an id) are the other servers'; items.ts holds the functions that read and write the items through a transaction's db
COPY servers/shared/rules.ts /src/forge/store.ts
COPY servers/shared/forge-items.ts /src/forge/items.ts
RUN bun /engine/packages/cli/src/index.ts engine prepare
ENV NODE_ENV=production
