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

# The native HTTP engine (packages/serve: Rust I/O threads, HTTP_ENGINE=archlast). Built on Debian 12 like the image below, so the library
# links the glibc it runs on. It is only the .node file that is carried over: no compiler reaches the image.
FROM rust:1.90-bookworm AS native
WORKDIR /serve
COPY packages/serve/Cargo.toml packages/serve/Cargo.lock ./
COPY packages/serve/crates crates
RUN cargo build --release --locked -p archlast-serve-napi \
  && mkdir native && cp target/release/libarchlast_serve_napi.so native/archlast_serve.node \
  && ldd native/archlast_serve.node

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
# The native engine: its TypeScript, and the library built above (the runtime picks it from HTTP_ENGINE=auto on 4 or more cores).
COPY --from=install /engine/packages/serve/package.json /engine/packages/serve/tsconfig.json packages/serve/
COPY --from=install /engine/packages/serve/src packages/serve/src
COPY --from=native /serve/native packages/serve/native
# The one library the native engine needs that distroless does not have (Rust's unwinder).
COPY --from=native /lib/x86_64-linux-gnu/libgcc_s.so.1 /lib/x86_64-linux-gnu/libgcc_s.so.1
# The user the engine runs as (below): distroless has no `bun` user, so it is added here, uid 1000 like the slim image's, with a home
# for bun's install cache (`engine prepare` and the dev engine run `bun install`). It owns /app and /data; /engine stays root's.
RUN ["/bin/sh", "-c", "echo 'bun:x:1000:1000:bun:/home/bun:/bin/sh' >> /etc/passwd && echo 'bun:x:1000:' >> /etc/group && mkdir -p /home/bun /app/forge/node_modules /data && chown -R 1000:1000 /home/bun /app /data"]
ENV NODE_ENV=production ARCHLAST_ENGINE=1 DATA_DIR=/data PORT=3000
# Not root: the `bun` user (uid 1000) added above. It writes /app (the project, copied in by `engine prepare` and on every start) and /data;
# /engine stays root's and read-only to it. A new volume on /data or /app/forge/node_modules takes this ownership from the image.
USER bun
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s CMD ["bun", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "/engine/packages/cli/src/index.ts"]
CMD ["engine", "serve"]
