# Tarkov Stats Comparator

Look up Escape from Tarkov player statistics, compare against the average player for your playtime, or go head-to-head with any other player by nickname.

## Running Locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Adding Streamers

Edit `data/streamers.json`:

```json
[
  { "name": "DisplayName", "nickname": "InGameNick" }
]
```

Streamers appear as quick-compare buttons on the player profile page.

## Deploying

Production runs on a rented VPS as Docker containers behind Caddy (TLS +
reverse proxy): see `docker-compose.vps.yml` + `Caddyfile`.

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

Sync the public nickname index into the same SQLite volume before using nickname
search:

```bash
docker compose -f docker-compose.vps.yml exec web node --experimental-sqlite scripts/sync-player-index.mjs
```

Run that command daily from cron/systemd timer. The upstream index is cached for
24 hours, and the script uses saved `ETag` / `Last-Modified` metadata to skip an
unchanged download.

Environment variables (in `.env`, see `.env.vps.example`):

| Var | Required | Purpose |
|-----|----------|---------|
| `AUTH_SECRET` | yes (for sign-in) | Signs the session JWT (`openssl rand -base64 32`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes (for sign-in) | Google OAuth client |
| `PUBLIC_BASE_URL` | yes behind a proxy | Pins the OAuth redirect URI (e.g. `https://tarkovstats.ru`) |
| `TRUSTED_IP_HEADER` | no (default `x-real-ip`) | Proxy header trusted for the rate-limit client IP (`cf-connecting-ip` behind Cloudflare) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | no | Turnstile sitekey (build-time) |
| `PLAYER_INDEX_USER_AGENT` | no | User-Agent used by the nickname-index sync script |

## Architecture

- **Next.js App Router** with TypeScript and Tailwind CSS
- All external API calls go through `/api/*` routes (server-side only)
- IP-based rate limiting: 30 requests/minute per endpoint
- Average-player stats are computed live from the collected player database (node:sqlite on the VPS)
- Security headers configured in `next.config.ts`

## External APIs

| API | Purpose |
|-----|---------|
| `players.tarkov.dev/profile/index.json` | Public nickname -> account id index for local search |
| `players.tarkov.dev/profile/{aid}.json` | Cached public player profile |
| `api.tarkov.dev/graphql` | Game data (player level XP thresholds) |
