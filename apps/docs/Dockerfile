# The docs site: build the static app with Bun, serve it with Caddy. Builds from this folder alone.
FROM oven/bun:1.4.4-slim AS build
WORKDIR /docs
COPY package.json ./
RUN bun install --ignore-scripts
COPY . .
# The site's address (https://docs.example.com) for canonical links and sitemap.xml. Without it both are left out.
ARG SITE_URL=""
RUN SITE_URL=$SITE_URL bun run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /docs/dist /srv
