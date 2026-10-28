# syntax=docker/dockerfile:1

# Native pilot is a separate process; the runtime contains no Rust toolchain.
FROM rust:1.98.1-alpine AS rust-builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY rust/cohort-worker/ ./
RUN cargo build --release --locked

FROM rust-builder AS rust-axis-builder
WORKDIR /native
COPY rust/axis-probability/ ./rust/axis-probability/
RUN cargo build --release --locked --manifest-path rust/axis-probability/Cargo.toml

FROM rust-builder AS rust-ui-builder
ARG TARGETARCH
RUN rustup target add wasm32-unknown-unknown
WORKDIR /native
COPY rust/ui/ ./rust/ui/
COPY lib/i18n/messages.json ./lib/i18n/messages.json
RUN cargo build --release --locked --manifest-path rust/ui/Cargo.toml --target wasm32-unknown-unknown --features hydrate
# Official static musl CLI; version matches the locked wasm-bindgen dependency.
RUN set -eu; case "$TARGETARCH" in \
      amd64) arch=x86_64; sum=82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e ;; \
      arm64) arch=aarch64; sum=2ed4351c35dd9440308bbb02767d47ea278efe851a52465300f3c94f5b6c2a87 ;; \
      *) echo "Unsupported build architecture: $TARGETARCH" >&2; exit 1 ;; esac; \
    name="wasm-bindgen-0.2.129-$arch-unknown-linux-musl"; \
    wget -q "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/$name.tar.gz" -O /tmp/wasm-bindgen.tar.gz; \
    echo "$sum  /tmp/wasm-bindgen.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/wasm-bindgen.tar.gz -C /tmp; \
    "/tmp/$name/wasm-bindgen" rust/ui/target/wasm32-unknown-unknown/release/tarkov_ui.wasm \
      --target web --no-typescript --out-name tarkov_ui --out-dir /native/wasm

FROM rust-builder AS rust-api-builder
WORKDIR /native
COPY rust/backend/ ./rust/backend/
COPY rust/ui/ ./rust/ui/
COPY lib/i18n/messages.json ./lib/i18n/messages.json
RUN cargo build --release --locked --manifest-path rust/backend/Cargo.toml

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

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=rust-ui-builder /native/wasm /rust-ui-wasm
RUN node scripts/build-rust-ui.mjs --prebuilt /rust-ui-wasm
RUN npm run build

# ---------- 3. Финальный образ (минимальный) ----------
FROM node:22-alpine AS runner
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
LABEL org.tarkovstats.rust-http="seasonal-v1"
LABEL org.tarkovstats.rust-home-showcase="v1"
LABEL org.tarkovstats.rust-arena-ui="v1"
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
COPY --from=rust-builder --chown=nextjs:nodejs /build/target/release/tarkov-cohort-worker ./rust/cohort-worker/target/release/tarkov-cohort-worker
COPY --from=rust-axis-builder --chown=nextjs:nodejs /native/rust/axis-probability/target/release/axis-probability ./rust/axis-probability/target/release/axis-probability
COPY --from=rust-api-builder --chown=nextjs:nodejs /native/rust/backend/target/release/tarkov-backend ./rust/backend/target/release/tarkov-backend
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-player-index.mjs ./scripts/sync-player-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-pve-index.mjs ./scripts/sync-pve-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-pve-profiles.mjs ./scripts/sync-pve-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-arena-index.mjs ./scripts/sync-arena-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-arena-profiles.mjs ./scripts/sync-arena-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/regular-profile-sync-core.mjs ./scripts/regular-profile-sync-core.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/run-profile-queue.mjs ./scripts/run-profile-queue.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-regular-profiles.mjs ./scripts/sync-regular-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-seasonal-profiles.mjs ./scripts/sync-seasonal-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-seasonal-index.mjs ./scripts/sync-seasonal-index.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/seasonal-profile-sync-core.mjs ./scripts/seasonal-profile-sync-core.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/import-ban-list.mjs ./scripts/import-ban-list.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backfill-admin-risk.mjs ./scripts/backfill-admin-risk.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backfill-seasonal-average.mjs ./scripts/backfill-seasonal-average.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backfill-progression.mjs ./scripts/backfill-progression.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backfill-regular-progression.mjs ./scripts/backfill-regular-progression.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/warm-average-cache.mjs ./scripts/warm-average-cache.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/start-web.mjs ./scripts/start-web.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/verify-rust-http-runtime.mjs ./scripts/verify-rust-http-runtime.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/web-runtime-health.mjs ./scripts/web-runtime-health.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/supervise-worker.mjs ./scripts/supervise-worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sync-axis-league.mjs ./scripts/sync-axis-league.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/axis-discord-bot.mjs ./scripts/axis-discord-bot.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/sample-home-coverage.mjs ./scripts/sample-home-coverage.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/compute-average-worker.mjs ./scripts/compute-average-worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/compute-cohort-worker.mjs ./scripts/compute-cohort-worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/compute-admin-report.mjs ./scripts/compute-admin-report.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/compute-risk-worker.mjs ./scripts/compute-risk-worker.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/materialize-progression-population.mjs ./scripts/materialize-progression-population.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/materialize-achievement-tempo.mjs ./scripts/materialize-achievement-tempo.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/materialize-average-publications.mjs ./scripts/materialize-average-publications.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/materialize-leaderboards.mjs ./scripts/materialize-leaderboards.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backfill-leaderboard-exact-fields.mjs ./scripts/backfill-leaderboard-exact-fields.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/warmup-leaderboard-profiles.mjs ./scripts/warmup-leaderboard-profiles.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/ts-alias-loader.mjs ./scripts/ts-alias-loader.mjs
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/types ./types

# Каталог для локальной БД игроков (node:sqlite). Делаем его владельцем nextjs,
# чтобы примонтированный сюда docker-volume унаследовал права на запись.
RUN mkdir -p /data && chown nextjs:nodejs /data

USER nextjs

EXPOSE 3000 3001
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV RUST_API_BIN="/app/rust/backend/target/release/tarkov-backend"
ENV RUST_COHORT_BIN="/app/rust/cohort-worker/target/release/tarkov-cohort-worker"
ENV SQLITE_PATH="/data/players.db"
ENV BANS_SQLITE_PATH="/data/bans.db"
ENV PROGRESSION_SQLITE_PATH="/data/progression.db"
ENV ADMIN_ANALYTICS_SQLITE_PATH="/data/admin-analytics.db"
ENV AVERAGE_PUBLICATION_SQLITE_PATH="/data/average-publications.db"
ENV LEADERBOARD_SQLITE_PATH="/data/leaderboards.db"
# Process exclusion must not outlive the container; checkpoints remain in /data.
ENV LEADERBOARD_WARMUP_LOCK="/dev/shm/leaderboard-warmup.lock"

# --experimental-sqlite включает встроенный модуль node:sqlite (Node 22).
CMD ["node", "scripts/start-web.mjs"]
