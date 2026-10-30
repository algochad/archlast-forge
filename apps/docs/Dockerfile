# The docs site: build the static app with Bun, serve it with Caddy. Builds from this folder alone.
FROM oven/bun:1.4.3-slim AS build
WORKDIR /docs
COPY package.json ./
RUN bun install --ignore-scripts
COPY . .
RUN bun run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /docs/dist /srv
