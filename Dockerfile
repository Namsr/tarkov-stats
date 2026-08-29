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
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-player-index.mjs ./scripts/sync-player-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-pve-index.mjs ./scripts/sync-pve-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-pve-profiles.mjs ./scripts/sync-pve-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-arena-index.mjs ./scripts/sync-arena-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-arena-profiles.mjs ./scripts/sync-arena-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/lib/pve-progression-seed-core.ts ./lib/pve-progression-seed-core.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/regular-profile-sync-core.mjs ./scripts/regular-profile-sync-core.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-regular-profiles.mjs ./scripts/sync-regular-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-seasonal-profiles.mjs ./scripts/sync-seasonal-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-seasonal-index.mjs ./scripts/sync-seasonal-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/seasonal-profile-sync-core.mjs ./scripts/seasonal-profile-sync-core.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backfill-admin-risk.mjs ./scripts/backfill-admin-risk.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backfill-seasonal-average.mjs ./scripts/backfill-seasonal-average.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/warm-average-cache.mjs ./scripts/warm-average-cache.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/start-web.mjs ./scripts/start-web.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/materialize-progression-population.mjs ./scripts/materialize-progression-population.mjs
COPY --from=builder --chown=nextjs:nodejs /app/lib/brackets.ts ./lib/brackets.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/cheater-score.ts ./lib/cheater-score.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/admin/moderation-db.ts ./lib/admin/moderation-db.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/arena/storage.ts ./lib/arena/storage.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/tarkov-api.ts ./lib/tarkov-api.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/config.ts ./lib/seasonal/config.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/storage.ts ./lib/seasonal/storage.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/regular-progression.ts ./lib/regular-progression.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/playtime-brackets.ts ./lib/playtime-brackets.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/analytics.ts ./lib/seasonal/analytics.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/d1.ts ./lib/seasonal/d1.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/daily-aggregates.ts ./lib/seasonal/daily-aggregates.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/progression.ts ./lib/seasonal/progression.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/progression-db.ts ./lib/seasonal/progression-db.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/progression-details.ts ./lib/seasonal/progression-details.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/seasonal/storage-d1.ts ./lib/seasonal/storage-d1.ts
COPY --from=builder --chown=nextjs:nodejs /app/types/seasonal.ts ./types/seasonal.ts
COPY --from=builder --chown=nextjs:nodejs /app/types/arena.ts ./types/arena.ts
COPY --from=builder --chown=nextjs:nodejs /app/types/tarkov.ts ./types/tarkov.ts

# Каталог для локальной БД игроков (node:sqlite). Делаем его владельцем nextjs,
# чтобы примонтированный сюда docker-volume унаследовал права на запись.
RUN mkdir -p /data && chown nextjs:nodejs /data

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV SQLITE_PATH="/data/players.db"
ENV BANS_SQLITE_PATH="/data/bans.db"
ENV PROGRESSION_SQLITE_PATH="/data/progression.db"
ENV ADMIN_ANALYTICS_SQLITE_PATH="/data/admin-analytics.db"

# --experimental-sqlite включает встроенный модуль node:sqlite (Node 22).
CMD ["node", "scripts/start-web.mjs"]
