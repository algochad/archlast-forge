# The benchmark's API on the engine image (build context: benchmarks/rest). HTTP_ENGINE picks the server at start: archlast (default on 4+ cores) or bun.
ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.17.0
FROM ${ENGINE_IMAGE}
COPY servers/forge /src
COPY servers/shared/store.ts /src/forge/store.ts
RUN bun /engine/packages/cli/src/index.ts engine prepare
ENV NODE_ENV=production
