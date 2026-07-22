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

### VPS runbook

- SSH target: `$env:TARKOVSTATS_SSH_USER@$env:TARKOVSTATS_VPS`
- Local key: `$env:TARKOVSTATS_SSH_KEY`
- Project directory on the VPS: `/opt/tarkovstats`
- Compose file: `/opt/tarkovstats/docker-compose.vps.yml`
- Production traffic is DNS-only and goes directly to Caddy; deploying the app
  does not require enabling Cloudflare Proxy.

From PowerShell in the local project, first verify the build and create an
archive without secrets, generated files, databases, or backups:

```powershell
$env:TARKOVSTATS_PROJECT_DIR = "C:\path\to\tarkov-stats"
$env:TARKOVSTATS_SSH_KEY = "C:\path\to\private-key"
$env:TARKOVSTATS_SSH_USER = "root"
$env:TARKOVSTATS_VPS = "vps.example.com"
$deployTarget = "$($env:TARKOVSTATS_SSH_USER)@$($env:TARKOVSTATS_VPS)"

Set-Location $env:TARKOVSTATS_PROJECT_DIR
npm.cmd run build
Remove-Item "$env:TEMP\tarkovstats-deploy.tar.gz" -ErrorAction SilentlyContinue
tar -czf "$env:TEMP\tarkovstats-deploy.tar.gz" --exclude=.git --exclude=node_modules --exclude=.next --exclude=".env*" --exclude=.codex-local --exclude=backups --exclude=data --exclude="*.db*" .
scp -i "$env:TARKOVSTATS_SSH_KEY" -o IdentitiesOnly=yes "$env:TEMP\tarkovstats-deploy.tar.gz" "${deployTarget}:/tmp/tarkovstats-deploy.tar.gz"
ssh -i "$env:TARKOVSTATS_SSH_KEY" -o IdentitiesOnly=yes $deployTarget
```

If Windows OpenSSH rejects the private key because the Codex sandbox group has
access to it, remove that ACL entry in the same elevated PowerShell session
before `scp`/`ssh`:

```powershell
$env:TARKOVSTATS_KEY_ACL_PRINCIPAL = "$env:COMPUTERNAME\CodexSandboxUsers"
icacls "$env:TARKOVSTATS_SSH_KEY" /remove "$env:TARKOVSTATS_KEY_ACL_PRINCIPAL"
```

On the VPS, keep the currently running image as a one-step rollback, unpack the
new source, build it while the old container keeps serving traffic, and only
then replace the web container:

```bash
cd /opt/tarkovstats
docker image tag tarkovstats-web:latest tarkovstats-web:pre-deploy
tar -xzf /tmp/tarkovstats-deploy.tar.gz -C /opt/tarkovstats
docker compose -f docker-compose.vps.yml build web
docker compose -f docker-compose.vps.yml up -d --no-deps web
docker compose -f docker-compose.vps.yml ps
docker logs --since 5m --tail 100 tarkovstats-web-1
curl -fsSI https://tarkovstats.ru
curl -fsSI https://tarkovstats.online
rm -f /tmp/tarkovstats-deploy.tar.gz
```

The archive deliberately does not contain `.env`, `.env.private`, or database
files, so the VPS copies and the named Docker volume remain intact. Extraction
overwrites added/changed files but does not remove a source file deleted
locally; remove such a file explicitly on the VPS before the build. If
`Caddyfile` or the Compose configuration changed, validate/recreate the full
stack instead of using `--no-deps web`.

Rollback the web image without rebuilding:

```bash
cd /opt/tarkovstats
docker image tag tarkovstats-web:pre-deploy tarkovstats-web:latest
docker compose -f docker-compose.vps.yml up -d --no-deps --force-recreate web
docker compose -f docker-compose.vps.yml ps
```

For a small targeted change, copying only the changed files to the same paths
under `/opt/tarkovstats` is acceptable; still run the build, replacement, and
smoke checks above.

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
| `TRUSTED_IP_HEADER` | no (default `x-real-ip`) | Header set by Caddy from its verified client IP (keep `x-real-ip` for both DNS-only and Cloudflare-proxied traffic) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | no | Turnstile sitekey (build-time) |

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
| `json.tarkov.dev/regular/items` | Player level XP thresholds |
| `json.tarkov.dev/regular/tasks` | Achievement metadata |
| `json.tarkov.dev/regular/tasks_en` | English achievement names |
