# Никакого build-шага — бот гоняется прямо из TS через встроенный в node type
# stripping (по умолчанию с 22.18; tsconfig: erasableSyntaxOnly), поэтому один стейдж
# и `npm ci --omit=dev` без devDependencies.
# Нужен node ^22.19 || >=23.6 (engines; undici). Тег — минорный, без digest.
FROM node:22.21-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app

# пользователь node (uid 1000) идёт из базового образа; секреты в образ не попадают:
# .env и .env.* исключены в .dockerignore, конфигурация приходит через env_file/environment.
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 8443
# node:*-slim без curl — стучимся встроенным http
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=15s \
  CMD ["node", "-e", "require('http').get('http://localhost:8443/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

# без npm-обёртки — SIGTERM от docker stop доходит прямо до node (graceful shutdown)
CMD ["node", "src/main.ts"]
