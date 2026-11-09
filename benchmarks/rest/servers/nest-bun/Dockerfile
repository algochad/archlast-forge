# The same NestJS app (its Express adapter) on Bun (build context: benchmarks/rest).
FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY servers/nest/package.json .
RUN bun install --production
COPY servers/nest/*.ts servers/nest/tsconfig.json ./
COPY servers/shared/store.ts .
ENV NODE_ENV=production
CMD ["bun", "main.ts"]
