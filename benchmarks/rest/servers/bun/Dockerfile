FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY servers/shared/store.ts shared/store.ts
COPY servers/bun/server.ts bun/server.ts
ENV NODE_ENV=production
CMD ["bun", "bun/server.ts"]
