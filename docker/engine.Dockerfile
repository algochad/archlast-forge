# The archlast-forge engine: server, function runtime, dashboard and CLI.
# Build: archlast-forge engine build   (or: docker build -f docker/engine.Dockerfile -t archlast-forge/engine:<version> .)
FROM oven/bun:1.4.4-slim
WORKDIR /engine
COPY . .
# Workspace install from the lockfile; the apps aren't part of the engine.
RUN bun install --frozen-lockfile --ignore-scripts && rm -rf apps
ENV NODE_ENV=production ARCHLAST_ENGINE=1 DATA_DIR=/data PORT=3000
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD ["bun", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "/engine/packages/cli/src/index.ts"]
CMD ["engine", "serve"]
