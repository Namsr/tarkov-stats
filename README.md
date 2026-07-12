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

Production runs on a VPS as Docker containers behind Caddy (TLS + reverse
proxy): see `docker-compose.vps.yml` + `Caddyfile`. A home/Cloudflare-Tunnel
variant is documented in [SELFHOST.md](SELFHOST.md).

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

Nickname search uses a local SQLite copy of the public tarkov.dev player index.
Populate it after deployment, then run the same command daily from cron or a
systemd timer:

```bash
docker compose -f docker-compose.vps.yml exec web node --experimental-sqlite scripts/sync-player-index.mjs
```

The sync uses `ETag` / `Last-Modified`, so an unchanged index is not downloaded
or rewritten. Profiles themselves are still fetched on demand by account ID;
the refresh button bypasses the short local profile cache.

Environment variables (in `.env`, see `.env.selfhost.example`):

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
- Average-player stats are computed live from the collected player database (Cloudflare D1 in the hosted build, node:sqlite when self-hosted)
- Security headers configured in `next.config.ts`

## Historical player statistics

The project stores longitudinal player snapshots so future aggregate views can
describe not only a player's current statistics, but how those statistics change
over time. The first observation is a baseline; progression is calculated only
between later observations. Confirmed banned accounts are excluded from the
ordinary-player baseline and retained separately for aggregate research.

Runtime data uses three SQLite files in the same `/data` Docker volume:

- `players.db`: latest ordinary player rows used by the average-player pages;
- `progression.db`: historical snapshots of non-banned accounts;
- `bans.db`: banned accounts and their historical snapshots.

`backup-db.sh` creates online-consistent compressed backups of all three files.

## External APIs

| API | Purpose |
|-----|---------|
| `players.tarkov.dev/profile/index.json` | Public nickname to account-ID index for local search |
| `players.tarkov.dev/profile/{aid}.json` | Cached public player profile by account ID |
| `api.tarkov.dev/graphql` | Game data (player level XP thresholds) |
