# Leaderboard operations

Run the host commands below from `/opt/tarkovstats`.

The web process and the publisher must use the same Docker volume and paths:

```dotenv
SQLITE_PATH=/data/players.db
LEADERBOARD_SQLITE_PATH=/data/leaderboards.db
LEADERBOARD_ENABLED=true
LEADERBOARD_ACTIVITY_CUTOFF_MS=1763154000000
LEADERBOARD_ARENA_ACTIVITY_CUTOFF_MS=1763154000000
LEADERBOARD_REGULAR_MINIMUM_RAIDS=6
LEADERBOARD_PVE_MINIMUM_RAIDS=6
LEADERBOARD_SEASONAL_MINIMUM_RAIDS=6
LEADERBOARD_ARENA_MINIMUM_MATCHES=6
LEADERBOARD_LAST_HERO_MINIMUM_MATCHES=6
LEADERBOARD_ARP_SEASON_ID=initial
LEADERBOARD_ARP_SEASON_CONFIRMED=false
```

The existing host Compose setup mounts its named data volume at `/data`. The
systemd publication job runs `docker compose ... exec -T web`, so it receives
the same `env_file`, image, source database, and publication database as the
web routes. Do not run the publisher against a host-local database path.
Add these values to the deployment-local environment file already loaded by
the `web` service. `initial` is treated as the confirmed legacy ARP scope by the
application; the confirmation flag controls newly named seasons.

## First publication

Deploy and recreate `web` first so the application initializes the current
storage schema. Backfill exact values that can be recovered from stored source
payloads:

```bash
docker compose -f docker-compose.vps.yml up -d --build web
docker compose -f docker-compose.vps.yml exec -T web node --experimental-strip-types --experimental-sqlite scripts/backfill-leaderboard-exact-fields.mjs
```

The backfill does not infer exact PMC kills from rounded K/D. Profiles without
versioned exact counters remain outside the affected ranking until their normal
profile refresh supplies them.

Install the repository's publication unit and timer on the host, then run the
first complete publication through the service so it holds the same lock as
scheduled runs:

```bash
sudo install -m 0644 ops/systemd/tarkovstats-leaderboard-materialize.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/tarkovstats-leaderboard-materialize.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start tarkovstats-leaderboard-materialize.service
```

Verify the publication before enabling the timer:

```bash
docker compose -f docker-compose.vps.yml exec -T web node -e \
  'fetch("http://127.0.0.1:3000/api/leaderboard?mode=regular&sort=primary").then(async r=>{if(!r.ok)throw new Error(await r.text());console.log(await r.text())})'
docker compose -f docker-compose.vps.yml exec -T web \
  node --experimental-sqlite -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.LEADERBOARD_SQLITE_PATH,{readOnly:true});console.table(d.prepare("SELECT scope,generation,generated_at FROM leaderboard_current ORDER BY scope").all())'
```

```bash
sudo systemctl enable --now tarkovstats-leaderboard-materialize.timer
systemctl list-timers tarkovstats-leaderboard-materialize.timer
```

The timer fires daily at `04:00 Europe/Moscow`, persists missed runs, and the
service uses `flock` to prevent overlapping publications. The default command
reads the durable per-mode change journal populated by the existing profile
syncs, replaces only changed members and order keys, and recalculates exact
ordinals only for touched sorts. Each scope update is atomic. Regular and PvE
advance their mode cursor with that scope. Arena advances its cursor only with
the final successful Arena scope; if a later Arena scope fails, earlier scopes
may remain published, but the cursor does not advance and the next run safely
replays the complete mode window. Inspect failures with:

```bash
systemctl status tarkovstats-leaderboard-materialize.service
journalctl -u tarkovstats-leaderboard-materialize.service -n 100 --no-pager
```

Use `sudo systemctl start tarkovstats-leaderboard-materialize.service` for later
manual publications too. Calling the Node script directly bypasses the host
lock and can overlap the timer.

The default command automatically performs a full publication when no current
scope exists, or when the formula version, metric version, configuration,
active PvP cycle, Arena ARP season, or exclusion fingerprint changed. The
current PvP season uses its own `seasonal:<cycleId>` journal and publication
scope. Its eligibility cutoff is the later of the global PvP cutoff and the
configured cycle start. To rebuild all members while keeping
the saved reference formula, stop the timer and use the same host lock:

```bash
sudo systemctl stop tarkovstats-leaderboard-materialize.timer
sudo flock -n /run/tarkovstats-leaderboard.lock \
  docker compose -f docker-compose.vps.yml exec -T web \
  node --experimental-strip-types --experimental-sqlite scripts/materialize-leaderboards.mjs --full
sudo systemctl start tarkovstats-leaderboard-materialize.timer
```

Use `--recalibrate` in place of `--full` only when intentionally replacing the
reference medians after reviewing refreshed exact counters. Normal incremental
runs keep the published medians fixed. The one automatic exception is a scope
that originally had no usable reference: once changed profiles make a reference
available, the publisher adopts it and performs a full rebuild.

The first calibration uses 70% adjusted K/D, 30% adjusted kills per raid or
match, smoothing strength 20, and minimum samples of 6, including the separately
configured current PvP season. These are provisional operating values.
Recalibrate after enough profiles carry versioned exact
counters; changing them creates a new publication rather than rewriting a
completed generation.

## Capacity check

A local synthetic benchmark with 500,000 eligible profiles in one scope and
all four prepared sorts took 101.606 seconds for the first generation and
104.458 seconds for a second generation. Peak process memory was 236 MiB.
Retaining two generations used 1,138.5 MiB for that one scope; saved and fresh
focused reads took 11.27 and 7.97 ms. Worst-case updates that changed all four
sort keys took 103.796 seconds for 100 profiles, 98.961 seconds for 1,000, and
97.850 seconds for 10,000; global exact ordinal work consumed 89.029, 89.164,
and 90.455 seconds respectively. Incremental publication therefore avoids
reparsing and rewriting unchanged members, but it does not promise runtime
proportional to the number of changed profiles when a global order changes.
These figures are local test evidence, not a production forecast and not the
total for every persistent PvP, PvE, current-season PvP, and Arena scope. A real
CLI smoke test covers initial full publication, a stored delta, and a no-op.

Before rollout, check free space on the `/data` volume and run the benchmark or
one real publication against a copied database. Record total time, peak memory,
and final `leaderboards.db` size for all scopes. The 2-hour service timeout and
the 2 GiB VPS memory budget have headroom in the one-scope test; disk capacity
and the complete multi-scope run still require measurement on the target data.
