# Tuyere on its own: the engine image's copy of it (the same native library the engine ships) and a script that uses its App API (build context: benchmarks/rest).
ARG ENGINE_IMAGE=ghcr.io/algochad/archlast-forge-engine:0.17.0
FROM ${ENGINE_IMAGE}
WORKDIR /app
COPY servers/tuyere/server.ts servers/shared/store.ts ./
ENV NODE_ENV=production
ENTRYPOINT ["bun"]
CMD ["/app/server.ts"]
