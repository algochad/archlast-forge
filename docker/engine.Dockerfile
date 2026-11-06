# The archlast-forge engine: server, function runtime, dashboard and CLI.
# Build: archlast-forge engine build   (or: docker build -f docker/engine.Dockerfile -t archlast-forge/engine:<version> .)

# The dependencies, installed beside the whole repository (the lockfile names every workspace) and then cut down to what the engine runs.
FROM oven/bun:1.4.4-slim AS install
WORKDIR /engine
COPY . .
# Only the engine's workspaces: the CLI (with the runtime, the dashboard and create-archlast-forge's stack files) and the framework,
# which full-stack apps link. No dev dependencies, and no optional ones (the only one is TypeScript's native compiler).
RUN bun install --frozen-lockfile --production --omit optional --ignore-scripts --filter ./packages/cli --filter ./packages/framework
# Optional peers bun installs because another workspace uses them: TypeScript (@nestjs/graphql's compile-time plugin) and Vue
# (better-auth/vue, with the Babel parser its compiler needs); Prettier, which only scaffolding runs; then what nothing runs:
# type declarations, source maps, readmes and changelogs. Links left pointing at nothing go too.
RUN cd node_modules/.bun \
  && rm -rf typescript@* vue@* @vue+* @types+* @babel+parser@* @babel+types@* @babel+helper-string-parser@* @babel+helper-validator-identifier@* prettier@* \
  && find . -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -iname 'readme*' -o -iname 'changelog*' -o -iname 'history.md' \) -delete \
  && cd /engine && find node_modules packages -xtype l -delete

# The image: Bun on distroless (glibc, CA certificates, no package manager), BusyBox for /bin/sh and the usual commands
# (projects' Dockerfiles RUN through a shell, and packages' install scripts need one), the engine's packages as source
# (projects run /engine/packages/cli/src/index.ts) and those dependencies.
FROM oven/bun:1.4.4-distroless
COPY --from=busybox:1.37.0-musl /bin/busybox /bin/busybox
RUN ["/bin/busybox", "--install", "-s", "/bin"]
WORKDIR /engine
COPY --from=install /engine/package.json ./
COPY --from=install /engine/node_modules node_modules
COPY --from=install /engine/packages/cli packages/cli
COPY --from=install /engine/packages/runtime packages/runtime
COPY --from=install /engine/packages/dashboard packages/dashboard
COPY --from=install /engine/packages/framework packages/framework
COPY --from=install /engine/packages/client packages/client
COPY --from=install /engine/packages/react packages/react
COPY --from=install /engine/packages/create-archlast-forge packages/create-archlast-forge
ENV NODE_ENV=production ARCHLAST_ENGINE=1 DATA_DIR=/data PORT=3000
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD ["bun", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "/engine/packages/cli/src/index.ts"]
CMD ["engine", "serve"]
