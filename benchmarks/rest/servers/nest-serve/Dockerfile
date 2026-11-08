# The NestJS controller on archlast-serve with no archlast-forge: the engine image's copy of archlast-serve, and a basic Nest HTTP adapter over its App API (build context: benchmarks/rest).
ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.17.0
FROM ${ENGINE_IMAGE}
USER root
WORKDIR /app
COPY servers/nest/package.json .
RUN bun install --production
COPY servers/nest/items.controller.ts servers/nest/tsconfig.json ./
COPY servers/nest-serve/adapter.ts servers/nest-serve/main.ts ./
COPY servers/shared/store.ts .
USER bun
ENV NODE_ENV=production
ENTRYPOINT ["bun"]
CMD ["/app/main.ts"]
