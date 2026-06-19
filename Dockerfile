# syntax=docker/dockerfile:1

# ---------- 1. Установка зависимостей ----------
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- 2. Сборка приложения ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Turnstile sitekey вшивается в бандл во время сборки (NEXT_PUBLIC_*).
# Значение передаётся как build-arg из docker-compose.
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------- 3. Финальный образ (минимальный) ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Запуск под непривилегированным пользователем (безопасность):
# даже если приложение взломают, у него нет root внутри контейнера.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# standalone-вывод уже включает нужный кусок node_modules и server.js
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Каталог для локальной БД игроков (node:sqlite). Делаем его владельцем nextjs,
# чтобы примонтированный сюда docker-volume унаследовал права на запись.
RUN mkdir -p /data && chown nextjs:nodejs /data

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV SQLITE_PATH="/data/players.db"

# --experimental-sqlite включает встроенный модуль node:sqlite (Node 22).
CMD ["node", "--experimental-sqlite", "server.js"]
