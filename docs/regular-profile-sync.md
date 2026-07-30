# Regular profile synchronization

The VPS polls `profile/updated.json` at `:05`, `:20`, `:35`, and `:50` each
hour. The feed is parsed as a stream and is never stored as a raw file.
Tracked AIDs are queued when their feed version is newer than
`players.profile_updated_at`.

The first successful poll also stores a durable feed watermark. Unknown AIDs
are deliberately ignored during that bootstrap poll, so an existing feed
cannot enqueue its entire history. Later polls admit unknown AIDs at or after
the saved watermark minus the configured overlap (one hour by default). This
small overlap catches late feed entries without reopening old history.

The SQLite queue is idempotent by AID and keeps only the newest observed
version. It does not require a matching `players` row, so a successful refresh
can create a newly admitted profile. A restart resumes `pending` and `error`
rows. HTTP 404 is retained as `not_found`; it never confirms a ban and never
deletes the player. A later, newer feed version reopens that AID for retry.
`excluded_players` rows are neither queued nor processed.

Successful refreshes update `players`, the `player_index` nickname, and the
`regular/persistent` progression snapshot through the authenticated operator
endpoint. The endpoint remains responsible for snapshot deduplication and
reset/schema-anomaly handling.

## VPS rollout

Do not run this collector on a developer workstation or as part of
`npm run dev`. It is a VPS-only scheduled job.

Deploy the image containing the profile-version/progression migrations, the
authenticated `/api/operator/profile-refresh/sync` endpoint, and both sync
scripts. The operator route and its server-only helpers must be present in the
private deployment bundle. The web container receives the same
`PROFILE_REFRESH_SECRET` used by the job.

Stop and remove the legacy importer before backing up or enabling either
writer:

```sh
cd /opt/tarkovstats
docker stop tarkovstats-public-profile-importer
docker rm tarkovstats-public-profile-importer
docker container inspect tarkovstats-public-profile-importer
```

The final command must report that the container does not exist. Both supplied
services refuse to start while it exists, even when stopped.

Back up both SQLite databases before the migration. Stopping `web` gives a
consistent copy including any WAL contents. Replace the timestamp below if the
rollout is resumed:

```sh
cd /opt/tarkovstats
backup_dir="/opt/tarkovstats-backups/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 700 "$backup_dir"
docker compose -f docker-compose.vps.yml stop web
docker compose -f docker-compose.vps.yml run --rm -T --no-deps \
  -v "$backup_dir:/backup" --entrypoint sh web \
  -c 'cp /data/players.db /data/progression.db /backup/'
docker compose -f docker-compose.vps.yml up -d web
ls -lh "$backup_dir/players.db" "$backup_dir/progression.db"
```

Start the deployed web service once before the collector so its idempotent
SQLite initialization applies the current schema. Then run one manual feed
poll. This bootstrap refreshes newer versions for profiles already in
`players`, stores the watermark, and does not admit the historical unknown
population:

```sh
sudo systemctl start tarkovstats-regular-profile-sync.service
journalctl -fu tarkovstats-regular-profile-sync.service
```

Install and enable the units after the manual run:

```sh
sudo cp ops/systemd/tarkovstats-*.service ops/systemd/tarkovstats-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tarkovstats-regular-profile-sync.timer
sudo systemctl enable --now tarkovstats-player-index-sync.timer
systemctl list-timers 'tarkovstats-*sync.timer'
```

`tarkovstats-player-index-sync.timer` reads `index.json` every day at 00:00
`Europe/Moscow`. `tarkovstats-regular-profile-sync.timer` reads
`updated.json` every 15 minutes with the five-minute offset. There is no
random delay. Both services share `/run/tarkovstats-data-sync.lock`; the daily
index job waits for that lock so its only run is not discarded. systemd does
not start a second instance of the same oneshot service, and the SQLite lease
is a second guard against concurrent queue writers.

## Verification

The last successful run stores both a JSON `last_summary` and individual rows
in `regular_profile_sync_meta` for poll time, maximum feed timestamp, backlog,
new profiles, updated profiles, errors, and duration. The durable admission
boundary is stored as `feed_watermark`.

```sh
journalctl -u tarkovstats-regular-profile-sync.service -n 100 --no-pager
docker compose -f docker-compose.vps.yml exec -T web node --experimental-sqlite -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.SQLITE_PATH || "/data/players.db");
  console.table(db.prepare(
    "SELECT key, value FROM regular_profile_sync_meta ORDER BY key"
  ).all());
  console.table(db.prepare(
    "SELECT status, COUNT(*) AS n FROM regular_profile_sync_queue GROUP BY status"
  ).all());
'
```

Acceptance checks:

- a second poll of the same feed version does not add a snapshot;
- an AID newer than the bootstrap boundary is admitted even without a current
  `players` row;
- two different profile versions produce two progression snapshots with their
  respective PMC raid counts;
- 404 rows remain in the queue as `not_found`;
- `systemctl list-timers` shows midnight Moscow for the index and all four
  quarter-hour feed slots.

The `SUMMARY` log also includes coverage across all tracked, non-excluded
Regular profiles, `missingFromFeed`, queue statuses, and whether the run was
the initial bootstrap. Profiles absent from `updated.json` remain in the
coverage denominator.

The average APIs still default to the complete dataset. Once
`coveragePercent >= 95`, clients may explicitly request the 90-day Regular
sample with `/api/average?period=90d`. This period filter affects averages and
comparison cohorts only; it does not define collector membership.

## Configuration

Defaults are two profile requests per second, three bounded retries with
exponential backoff, a 30-second request timeout, and a one-hour late-entry
overlap:

```text
REGULAR_PROFILE_SYNC_RPS=2
REGULAR_PROFILE_SYNC_MAX_RETRIES=3
REGULAR_PROFILE_SYNC_TIMEOUT_MS=30000
REGULAR_PROFILE_SYNC_LEASE_MS=1800000
REGULAR_PROFILE_SYNC_OVERLAP_MS=3600000
REGULAR_PROFILE_UPDATED_URL=https://players.tarkov.dev/profile/updated.json
REGULAR_PROFILE_SYNC_BASE_URL=http://127.0.0.1:3000
```

The feed URL receives a cache key stable for one 15-minute UTC slot. Retries
therefore reuse the same CDN object while the next scheduled poll bypasses a
stale one. Adjust the overlap only when observed feed lateness justifies it;
increasing it also increases how many pre-boundary unknown AIDs may be
admitted.

Seasonal remains fail-closed and uses its own confirmed upstream adapter and
`cycleId`. This Regular collector does not invent a Seasonal URL and does not
collect PvE or Arena profiles.
