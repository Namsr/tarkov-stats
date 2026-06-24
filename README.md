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

Environment variables (in `.env`, see `.env.selfhost.example`):

| Var | Required | Purpose |
|-----|----------|---------|
| `AUTH_SECRET` | yes (for sign-in) | Signs the session JWT (`openssl rand -base64 32`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes (for sign-in) | Google OAuth client |
| `PUBLIC_BASE_URL` | yes behind a proxy | Pins the OAuth redirect URI (e.g. `https://tarkovstats.ru`) |
| `TRUSTED_IP_HEADER` | no (default `x-real-ip`) | Proxy header trusted for the rate-limit client IP (`cf-connecting-ip` behind Cloudflare) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | no | Turnstile sitekey (build-time) |

## Architecture

- **Next.js App Router** with TypeScript and Tailwind CSS
- All external API calls go through `/api/*` routes (server-side only)
- IP-based rate limiting: 30 requests/minute per endpoint
- Average-player stats are computed live from the collected player database (Cloudflare D1 in the hosted build, node:sqlite when self-hosted)
- Security headers configured in `next.config.ts`

## External APIs

| API | Purpose |
|-----|---------|
| `player.tarkov.dev/name/{nick}` | Search players by nickname |
| `player.tarkov.dev/account/{aid}` | Fetch full player profile |
| `api.tarkov.dev/graphql` | Game data (player level XP thresholds) |
