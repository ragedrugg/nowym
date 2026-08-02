# Никакого build-шага — бот гоняется прямо из TS через tsx (см. package.json),
# поэтому один стейдж и tsx остаётся в зависимостях (не devDependencies-only install).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 8443
CMD ["npm", "run", "start"]
