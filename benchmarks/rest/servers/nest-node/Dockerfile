# NestJS (its Express adapter) on Node (build context: benchmarks/rest).
FROM node:24-alpine AS build
WORKDIR /app
COPY servers/nest/package.json .
RUN npm install --no-audit --no-fund
COPY servers/nest/*.ts servers/nest/tsconfig.json ./
COPY servers/shared/store.ts .
RUN npx tsc

FROM node:24-alpine
WORKDIR /app
COPY servers/nest/package.json .
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
