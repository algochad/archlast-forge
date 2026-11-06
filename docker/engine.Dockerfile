# The archlast-forge engine: server, function runtime, dashboard and CLI.
# Build: archlast-forge engine build   (or: docker build -f docker/engine.Dockerfile -t archlast-forge/engine:<version> .)
FROM oven/bun:1.4.4-slim
WORKDIR /engine
COPY . .
# Workspace install from the lockfile; the apps aren't part of the engine.
RUN bun install --frozen-lockfile --ignore-scripts && rm -rf apps \
  && mkdir -p /app/forge/node_modules /data && chown -R bun:bun /app /data
ENV NODE_ENV=production ARCHLAST_ENGINE=1 DATA_DIR=/data PORT=3000
# Not root: the base image's `bun` user (uid 1000). It writes /app (the project, copied in by `engine prepare` and on every start) and /data;
# /engine stays root's and read-only to it. A new volume on /data or /app/forge/node_modules takes this ownership from the image.
USER bun
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD ["bun", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "/engine/packages/cli/src/index.ts"]
CMD ["engine", "serve"]
