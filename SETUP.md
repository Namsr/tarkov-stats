# Setup — player aggregates (D1)

The player-stats feature stores one row per looked-up player (keyed by account
id) in a Cloudflare D1 database. Re-looking up the same player UPDATES their row
rather than duplicating it, so derived per-bracket stats (the "average player
portrait") aren't skewed by repeat views. Search is by account id only.

## One-time setup

1. **Create the D1 database** and copy the returned `database_id`:

   ```bash
   npm run d1:create
   ```

2. **Paste the id** into `wrangler.jsonc` → `d1_databases[0].database_id`
   (replace `REPLACE_WITH_D1_DATABASE_ID`).

3. **Apply migrations**:

   ```bash
   npm run d1:migrate:local    # local dev DB
   npm run d1:migrate:remote   # production DB (run again after adding new migrations)
   ```

> ⚠️ `wrangler deploy` does **not** run migrations automatically. After every
> new migration you must run `npm run d1:migrate:remote` or the production
> tables won't exist and aggregate writes silently no-op.

4. **Commit the schema** so it travels with the repo / CI:

   ```bash
   git add migrations/
   ```

## Regenerate types after editing `wrangler.jsonc`

```bash
npm run cf-typegen
```
