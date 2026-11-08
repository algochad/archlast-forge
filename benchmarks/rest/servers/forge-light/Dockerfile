# The benchmark's API on forge/http.ts's own routes, written with lightAction (build context: benchmarks/rest).
ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.17.0
FROM ${ENGINE_IMAGE}
COPY servers/forge-light /src
COPY servers/shared/store.ts /src/forge/store.ts
RUN bun /engine/packages/cli/src/index.ts engine prepare
ENV NODE_ENV=production
