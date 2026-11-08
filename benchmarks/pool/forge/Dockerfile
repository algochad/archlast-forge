ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.17.0
FROM ${ENGINE_IMAGE}
COPY . /src
RUN bun /engine/packages/cli/src/index.ts engine prepare
ENV NODE_ENV=production
