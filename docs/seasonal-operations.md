# Seasonal operations runbook

Seasonal collection is intentionally fail-closed. Keep both rollout flags disabled until a real response from the configured upstream has been saved as a fixture and its contract has passed the adapter tests.

## Configuration

Configure the application runtime with:

```dotenv
SEASONAL_ENABLED=false
SEASONAL_CYCLE_ID=season-id
SEASONAL_STARTS_AT=2026-07-01T00:00:00+03:00
SEASONAL_ENDS_AT=
SEASONAL_UPSTREAM_CONTRACT=game_mode
SEASONAL_PROFILE_URL_TEMPLATE=https://players.tarkov.dev/.../{aid}
COMMUNITY_HELPER_ENABLED=false
HELPER_COOKIE_SECRET=
PROFILE_REFRESH_SECRET=
```

`SEASONAL_UPSTREAM_CONTRACT` is exactly `game_mode` or `profile_section`. The cycle id must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Dates accept epoch seconds, epoch milliseconds, or an ISO timestamp. The profile URL must be HTTPS, have the exact host `players.tarkov.dev`, and contain `{aid}`.

`SEASONAL_ENABLED=true` only exposes Seasonal after all cycle and upstream settings are valid. The community helper additionally requires `COMMUNITY_HELPER_ENABLED=true` and a separate `HELPER_COOKIE_SECRET` of at least 32 characters. `PROFILE_REFRESH_SECRET` is a different server-only secret of at least 32 characters; never expose either secret through a `NEXT_PUBLIC_` variable.

## Storage and migrations

Self-hosted deployments use `PROGRESSION_SQLITE_PATH` (default `/data/progression.db`). Schema initialization and the legacy `regular/persistent` backfill run idempotently when the Seasonal store first opens. The Compose service mounts `/data` in the named `tarkov-data` volume and reads runtime values from `.env`.

Cloudflare deployments use the existing D1 binding named `DB`. Add the actual database name/id to the deployment-specific Wrangler configuration, then apply the full schema to a fresh database:

```powershell
npx wrangler d1 execute <database-name> --remote --file scripts/seasonal-storage-d1.sql
```

Apply the favorites migration once as well. It is safe for both a fresh database and the legacy `(user_sub, aid)` table; existing rows are retained as `regular/persistent`:

```powershell
npx wrangler d1 execute <database-name> --remote --file scripts/favorites-d1.sql
```

Create the isolated PVE/Arena portrait store and its read views:

```powershell
npx wrangler d1 execute <database-name> --remote --file scripts/player-modes-d1.sql
```

This migration is idempotent. PVP continues to use the existing `players` table; PVE and Arena share `mode_players` and are separated by its composite `(mode, aid)` key.

`favorites-d1.sql` is a versioned rebuild, not an idempotent initializer. Do not run it again after the database has `mode` and `cycle_id`: static SQLite/D1 SQL cannot conditionally refer to columns that may not exist. Self-hosted SQLite performs the corresponding column inspection and transactional rebuild in application code.

For a database that already received an earlier Seasonal schema without scanner lifecycle fields, apply only:

```powershell
npx wrangler d1 execute <database-name> --remote --file scripts/seasonal-scanner-lifecycle-d1.sql
```

An existing Seasonal database created before lease-attempt outcomes and changed-snapshot eligibility also needs the correctness upgrade. Apply the lifecycle upgrade first if that database does not yet have `progression_eligible`, then apply:

```powershell
npx wrangler d1 execute <database-name> --remote --file scripts/seasonal-scanner-correctness-d1.sql
```

Do not apply either upgrade after the current full schema: their `ALTER TABLE` statements are deliberately non-repeatable. Back up the production database before any manual migration. D1 multi-statement batches used by the stores are transactional; scanner preparation and aggregate materialization are idempotent so the next run repairs an interrupted preparation pass.

## Rollout sequence

1. Keep both flags `false`; configure the cycle and deploy the migration.
2. Save a real upstream response as a scrubbed fixture, select its matching contract, and run `npm test`.
3. Set only `SEASONAL_ENABLED=true`. Verify `/player/seasonal/<aid>`, `/average/seasonal`, snapshots, interval statuses, panel coverage, and aggregate freshness.
4. Run the operator until the first two distinct changed snapshots unlock progression eligibility. Do not manufacture a second snapshot or interpolate missing dates.
5. Set `COMMUNITY_HELPER_ENABLED=true` only after the operator queue and server verification are healthy. Roll back either surface immediately by setting its corresponding flag to `false`.

The combined public risk reuses the existing single-profile model with server-stored Seasonal prestige, streak and achievement ids, plus the existing playtime and achievement baselines when available. If those baseline stores are temporarily unavailable, it falls back to the model's established absolute thresholds; no client-supplied score is accepted.

## Operator runner

The local browser runner is `scripts/profile-refresh.mjs`. It deliberately uses the operator's existing signed-in Brave profile and does not bypass Cloudflare. The runner and its regular-profile operator support are intentionally excluded by `.gitignore-private`, so deployments must provision the existing private operator bundle separately; the tracked Seasonal routes do not by themselves provide a browser runner. Close Brave before starting it. Configure the runner process (not the browser) with:

```dotenv
PROFILE_REFRESH_MODE=seasonal
PROFILE_REFRESH_CYCLE_ID=season-id
PROFILE_REFRESH_OWNER=operator-unique-name
PROFILE_REFRESH_BASE_URL=https://your-tarkovstats-host
PROFILE_REFRESH_SECRET=<same server bearer secret>
PROFILE_REFRESH_USER_DATA_DIR=<Brave user-data directory>
BRAVE_PROFILE_DIRECTORY=Default
```

Start it with `node scripts/profile-refresh.mjs`. The server resumes the active run for the same owner and cycle. One task is leased for five minutes. A task outcome is `completed`, `skipped`, `not_found`, `rate_limited`, `upstream_error`, or `schema_error`; the run stops after five consecutive system outcomes (`rate_limited`, `upstream_error`, or `schema_error`). An ordinary outcome resets that counter.

For cross-sectional PVE or Arena portraits, use the same runner with `PROFILE_REFRESH_MODE=pve` or `PROFILE_REFRESH_MODE=arena`. These modes reuse the regular candidate queue, write only to the isolated mode store, do not create longitudinal snapshots, and skip the regular ban-check stage.

Operator-only `ban_check` work requires evidence `tarkov_dev_name_search_absence` bound to the active lease. Helper sessions can claim only `profile` and `linked_pvp` work, receive one to three tasks, poll for at most three minutes, and cannot supply profile JSON or a trusted risk score.

Queue priorities are fixed:

1. stale members of the 2,000-account panel;
2. stale eligible community history;
3. accounts waiting for a second distinct snapshot or linked-PvP hours;
4. discovery candidates.

Use `GET /api/operator/seasonal/status?cycleId=<id>` with the Bearer secret to inspect coverage, ready/expired work, operational errors, ban checks, and community backlog. All operator responses are `no-store`.

## Daily verification

- Confirm the panel has all eight lifetime-PvP-hour bands, with the configured 150-seat minimum where population permits and no more than 2,000 total members.
- Inspect `schema_error`, reset, and stale outcomes before trusting cohort charts.
- Confirm aggregates use the latest snapshot per Moscow calendar date and that freshness advances.
- Treat low confidence, a missing nearby cohort, and gaps in dates as valid states—not as data to fill.
- Keep PvP/PvE/Arena out of the longitudinal scanner; this first panel is Seasonal only.
