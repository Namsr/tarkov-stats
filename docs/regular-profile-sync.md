# Regular profile synchronization

The daily job reads `profile/updated.json`, keeps only AIDs already present in
the regular `players` table, and refreshes rows whose feed version is newer
than `players.profile_updated_at`. The feed is parsed as a stream. Its
persistent queue makes restarts idempotent; a SQLite lease and the systemd
`flock` prevent overlapping writers.

Successful refreshes also update the corresponding `player_index` nickname.
HTTP 404 is recorded as `not_found`; it never confirms a ban and never deletes
the player. `excluded_players` rows are neither queued nor processed.

## Rollout

Deploy the image containing the profile-version migration, the authenticated
`/api/operator/profile-refresh/sync` endpoint, and both scripts before enabling
the timer. The operator route and its server-only helper modules are kept in
the private deployment bundle rather than the public Git repository; confirm
that the release archive includes them. The web container already receives
`PROFILE_REFRESH_SECRET` through its existing env files.

The legacy importer must be stopped and removed before the new timer is
enabled; otherwise it can overwrite corrected statistics with its old parser:

```sh
docker stop tarkovstats-public-profile-importer
docker rm tarkovstats-public-profile-importer
docker container inspect tarkovstats-public-profile-importer
```

The final command must report that the container does not exist. Both supplied
services refuse to start while that legacy container still exists, even if it
is stopped.

Install the units (adjust `/opt/tarkovstats` inside the service files if the
checkout lives elsewhere):

```sh
sudo cp ops/systemd/tarkovstats-*.service ops/systemd/tarkovstats-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tarkovstats-regular-profile-sync.timer
sudo systemctl enable --now tarkovstats-player-index-sync.timer
```

Run the initial tracked refresh explicitly and follow its summary. Existing
rows start with profile version `0`, so this first run covers the full tracked
regular population (roughly 50,000 profiles):

```sh
sudo systemctl start tarkovstats-regular-profile-sync.service
journalctl -fu tarkovstats-regular-profile-sync.service
```

The daily timer does **not** download the full nickname index. The separate
weekly timer runs the existing ETag/Last-Modified-aware index sync as a safety
net for new or previously untracked accounts. A successful profile refresh
keeps the nickname index current between weekly runs.

Useful checks:

```sh
systemctl list-timers 'tarkovstats-*sync.timer'
journalctl -u tarkovstats-regular-profile-sync.service -n 100 --no-pager
docker compose -f docker-compose.vps.yml exec -T web node --experimental-sqlite scripts/sync-regular-profiles.mjs
```

The final `SUMMARY` log includes coverage across all tracked, non-excluded
Regular profiles, `missingFromFeed`, eligible versions, completed refreshes,
404s, errors, and persistent queue status counts. Coverage counts a profile
only after it has a positive `profile_updated_at`; profiles absent from
`updated.json` stay in the denominator.

Keep `AVERAGE_PROFILE_MAX_AGE_DAYS` disabled during the initial refresh. After
the latest completed summary reports `coveragePercent >= 95`, enable the
90-day average window and recreate the web service:

```sh
journalctl -u tarkovstats-regular-profile-sync.service --no-pager \
  | grep ' SUMMARY ' | tail -1
# in the production env file
AVERAGE_PROFILE_MAX_AGE_DAYS=90
docker compose -f docker-compose.vps.yml up -d --force-recreate web
```

Do not enable the cutoff before that threshold: doing so would calculate the
average from a temporarily incomplete sample. Check the next `/api/average`
response and its sample sizes after the restart.

## Configuration

Defaults are two profile requests per second, three bounded retries with
exponential backoff, and a 30-second request timeout. Override only when
needed:

```text
REGULAR_PROFILE_SYNC_RPS=2
REGULAR_PROFILE_SYNC_MAX_RETRIES=3
REGULAR_PROFILE_SYNC_TIMEOUT_MS=30000
REGULAR_PROFILE_SYNC_LEASE_MS=1800000
REGULAR_PROFILE_UPDATED_URL=https://players.tarkov.dev/profile/updated.json
REGULAR_PROFILE_SYNC_BASE_URL=http://127.0.0.1:3000
```

The 90-day setting filters average calculations only. It does not define
tracked membership; the daily refresh still covers the full regular `players`
table.
