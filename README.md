# Tarkov Stats Comparator

Look up Escape from Tarkov player statistics, compare against average player benchmarks, or go head-to-head with any other player by nickname.

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

## Regenerating Benchmarks

The benchmark script samples random players from the public index and computes median stats per raid-count bracket.

```bash
node scripts/generate-benchmarks.js
```

This takes ~25 minutes (5000 players at 300ms intervals). The output is written to `data/benchmarks.json`. Commit the updated file to the repository.

## Deploying to Vercel

1. Push this repository to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. Vercel auto-detects Next.js — no configuration needed.
4. Click **Deploy**.

No environment variables are required (all APIs are public).

## Architecture

- **Next.js App Router** with TypeScript and Tailwind CSS
- All external API calls go through `/api/*` routes (server-side only)
- IP-based rate limiting: 30 requests/minute per endpoint
- Benchmark data is a static JSON file (no database)
- Security headers configured in `next.config.ts`

## External APIs

| API | Purpose |
|-----|---------|
| `player.tarkov.dev/name/{nick}` | Search players by nickname |
| `player.tarkov.dev/account/{aid}` | Fetch full player profile |
| `players.tarkov.dev/profile/index.json` | Player index (for benchmark script) |
| `api.tarkov.dev/graphql` | Game data (player level XP thresholds) |
