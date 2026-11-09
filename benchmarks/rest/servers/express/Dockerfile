FROM node:24-alpine
WORKDIR /app
COPY servers/express/package.json .
RUN npm install --omit=dev --no-audit --no-fund
COPY servers/express/server.mjs .
# the same store module as the other JavaScript servers; Node strips its types when it loads it
COPY servers/shared/store.ts .
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
