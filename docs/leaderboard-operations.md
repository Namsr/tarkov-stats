# Leaderboard operations

Run the host commands below from `/opt/tarkovstats-auto`.

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
systemd publication job runs `docker compose -p tarkovstats ... exec -T web`, so it receives
the same `env_file`, image, source database, and publication database as the
web routes. Do not run the publisher against a host-local database path.
Add these values to the deployment-local environment file already loaded by
the `web` service. `initial` is treated as the confirmed legacy ARP scope by the
application; the confirmation flag controls newly named seasons.

## First publication

Before changing the host, capture a read-only baseline. These commands do not
print environment contents or secrets:

```bash
cd /opt/tarkovstats-auto
git rev-parse HEAD
git status --short
uptime
free -h
df -h / /var/lib/docker
docker compose -p tarkovstats -f docker-compose.vps.yml ps
docker stats --no-stream
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web sh -c 'du -h /data/*.db* 2>/dev/null'
ps -eo pid,etime,cmd --sort=-etime | head -n 30
systemctl list-timers --all 'tarkovstats-*'
systemctl list-units --type=service --all 'tarkovstats-*'
systemctl status tarkovstats-leaderboard-materialize.timer --no-pager
systemctl status tarkovstats-leaderboard-materialize.service --no-pager
systemctl list-timers --all tarkovstats-leaderboard-materialize.timer
```

If the read-only baseline shows insufficient room for the pristine backup,
working copies, publication output, and rollback margin, reclaim builder cache
before backup and recheck disk. Preserve all images, containers, and volumes;
do not use an image or system prune:

```bash
docker builder prune --force
docker system df
df -h / /var/lib/docker
```

Before merging or deploying the candidate, verify that the running image
exposes `node:sqlite.backup`, then create a pristine rollback set. The API
copies committed pages from a live WAL database, including changes that have
not reached the main `.db` file:

```bash
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web node --experimental-sqlite -e 'console.log(typeof require("node:sqlite").backup)'
R=/data/leaderboard-rollout/$(date +%Y%m%d-%H%M%S)
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web mkdir -p "$R"
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e R="$R" web node --experimental-sqlite -e 'const{DatabaseSync,backup}=require("node:sqlite");const{existsSync}=require("node:fs");(async()=>{for(const[n,e]of[["players.db","SQLITE_PATH"],["progression.db","PROGRESSION_SQLITE_PATH"],["leaderboards-before.db","LEADERBOARD_SQLITE_PATH"]]){if(!existsSync(process.env[e]))continue;const d=new DatabaseSync(process.env[e],{readOnly:true});try{await backup(d,process.env.R+"/"+n)}finally{d.close()}}})().catch(e=>{console.error(e);process.exit(1)})'
echo "$R"
```

Record `R` outside the shell session and leave these files untouched. Merge and
let the normal deployment build and recreate `web` once. Do not launch a second
candidate image. Use the SQLite backup API again to make a separate working set
from the pristine backups, then run the existing no-fetch schema initializers
against those working paths. Run backfill and publication only against the
working set and a new output database; the pristine rollback set remains
unchanged:

```bash
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e R="$R" web node --experimental-sqlite -e 'const{DatabaseSync,backup}=require("node:sqlite");(async()=>{for(const n of["players.db","progression.db"]){const d=new DatabaseSync(process.env.R+"/"+n,{readOnly:true});try{await backup(d,process.env.R+"/work-"+n)}finally{d.close()}}})().catch(e=>{console.error(e);process.exit(1)})'
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e SQLITE_PATH="$R/work-players.db" -e PROGRESSION_SQLITE_PATH="$R/work-progression.db" web node --experimental-strip-types --experimental-sqlite --experimental-loader ./scripts/ts-alias-loader.mjs --input-type=module -e "const {getStore}=await import('./lib/db.ts');if(!(await getStore('regular')))throw new Error('players schema init failed');const {DatabaseSync}=await import('node:sqlite');const {initializeSeasonalSchema}=await import('./lib/seasonal/storage.ts');const d=new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH||process.env.PROGRESSION_DB_PATH||'/data/progression.db');try{initializeSeasonalSchema(d)}finally{d.close()}console.log('profile schemas initialized')"
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e SQLITE_PATH="$R/work-players.db" -e PROGRESSION_SQLITE_PATH="$R/work-progression.db" web node --experimental-strip-types --experimental-sqlite scripts/backfill-leaderboard-exact-fields.mjs
time docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e SQLITE_PATH="$R/work-players.db" -e PROGRESSION_SQLITE_PATH="$R/work-progression.db" -e LEADERBOARD_SQLITE_PATH="$R/leaderboards-test.db" web node --experimental-strip-types --experimental-sqlite scripts/materialize-leaderboards.mjs --recalibrate
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e R="$R" web node --experimental-sqlite -e 'const{DatabaseSync}=require("node:sqlite");for(const n of["work-players.db","work-progression.db","leaderboards-test.db"]){const d=new DatabaseSync(process.env.R+"/"+n,{readOnly:true});console.log(n,d.prepare("PRAGMA integrity_check").get());d.close()}'
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web sh -c "du -h '$R'/*.db"
```

Watch `docker stats` from a second console while the copy run is active and
record its highest `web` memory value; that value already includes the running
web container and the publisher. The run must publish regular, PvE,
current-season PvP, and every Arena scope. Evaluate it together with Caddy and
the host's observed memory. If memory or disk does not retain reasonable
margin, stop the rollout and change capacity or retention before touching live
publication. Keep the pristine backup through the rollback window.

After the copy run passes, backfill exact values in the live source databases:

```bash
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web node --experimental-strip-types --experimental-sqlite --experimental-loader ./scripts/ts-alias-loader.mjs --input-type=module -e "const {getStore}=await import('./lib/db.ts');if(!(await getStore('regular')))throw new Error('players schema init failed');const {DatabaseSync}=await import('node:sqlite');const {initializeSeasonalSchema}=await import('./lib/seasonal/storage.ts');const d=new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH||process.env.PROGRESSION_DB_PATH||'/data/progression.db');try{initializeSeasonalSchema(d)}finally{d.close()}console.log('profile schemas initialized')"
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web node --experimental-strip-types --experimental-sqlite scripts/backfill-leaderboard-exact-fields.mjs
```

The backfill does not infer exact PMC kills from rounded K/D. Profiles without
versioned exact counters remain outside the affected ranking until their normal
profile refresh supplies them.

Run this backfill before the first leaderboard publication. If it is run after
a leaderboard already exists, stop the timer and hold
`/run/tarkovstats-leaderboard.lock`, then follow it immediately with
`materialize-leaderboards.mjs --full`. A late backfill is not an ordinary
journal-only delta and must not leave the published membership based on the old
exact-field state.

```bash
sudo systemctl stop tarkovstats-leaderboard-materialize.timer
sudo flock -n /run/tarkovstats-leaderboard.lock sh -c 'docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web node --experimental-strip-types --experimental-sqlite scripts/backfill-leaderboard-exact-fields.mjs && docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web node --experimental-strip-types --experimental-sqlite scripts/materialize-leaderboards.mjs --full'
sudo systemctl start tarkovstats-leaderboard-materialize.timer
```

## One-time profile warmup

The warmup refreshes only stored profiles produced by older parser generations.
It requests regular, then PvE, then Arena, then the configured current PvP
season, using one shared one-request-per-second pacer across modes and retries.
It excludes confirmed/global exclusions and does not retry profiles already
certified by the current parser merely because their exact metric is genuinely
missing.

Before the pilot, record the enabled and active state of the four existing
profile-sync timers and services. Stop them so they cannot issue profile
requests in parallel. Index-sync timers may remain active. Keep the leaderboard
timer disabled until the bounded pilot and first full publication finish:

```bash
systemctl is-enabled tarkovstats-{regular,pve,arena,seasonal}-profile-sync.timer
systemctl is-active tarkovstats-{regular,pve,arena,seasonal}-profile-sync.timer
sudo systemctl stop tarkovstats-{regular,pve,arena,seasonal}-profile-sync.timer
sudo systemctl stop tarkovstats-{regular,pve,arena,seasonal}-profile-sync.service
```

Run a bounded 20-profile pilot through a dedicated host lock:

```bash
sudo flock -n /run/tarkovstats-profile-warmup.lock docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e LEADERBOARD_WARMUP_MAX_PROFILES=20 web node --experimental-strip-types --experimental-sqlite scripts/warmup-leaderboard-profiles.mjs
```

Inspect web logs, the exit status, and
`/data/leaderboard-warmup-state.json`. Its attempted, completed, and skipped
counters are cumulative audit counters; they are not a count of remaining
profiles. Parser markers in the profile databases are the success/resume truth.
The checkpoint is replaced atomically and terminal skips are keyed by mode,
cycle or persistent scope, profile, source version, and target parser
generation.

After the pilot passes, start the resumable full warmup as an unattended host
unit. The dedicated host and in-container locks reject a second scanner, and
`systemd-run` retains its status and logs. The daily publisher can be installed
and enabled after its own first successful publication; it reads a consistent
source snapshot and later consumes warmup changes from the journal, so rollout
does not wait weeks for every legacy profile to refresh:

```bash
sudo systemd-run --unit=tarkovstats-profile-warmup --collect --property=WorkingDirectory=/opt/tarkovstats-auto /usr/bin/flock -n /run/tarkovstats-profile-warmup.lock /usr/bin/docker compose -p tarkovstats -f docker-compose.vps.yml exec -T -e LEADERBOARD_WARMUP_MAX_PROFILES=100000 web node --experimental-strip-types --experimental-sqlite scripts/warmup-leaderboard-profiles.mjs
journalctl -u tarkovstats-profile-warmup -f
```

Stopping the transient host unit can stop only the `docker compose exec`
client, so do not treat that alone as a scanner stop. Request the host stop,
read `/data/leaderboard-warmup.lock` inside `web`, verify that its PID's
`/proc/<pid>/cmdline` names `warmup-leaderboard-profiles.mjs`, then send that
verified process `TERM`. Wait for the matching owner to remove the lock before
resuming with the same `systemd-run` command. If the PID no longer exists,
verify that no warmup process is running before manually removing the stale
lock. Never delete the lock while its recorded process is alive.

```bash
sudo systemctl stop tarkovstats-profile-warmup
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web cat /data/leaderboard-warmup.lock
PID=replace-with-the-verified-numeric-pid
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web sh -c "tr '\000' ' ' </proc/$PID/cmdline"
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web kill -TERM "$PID"
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web test ! -e /data/leaderboard-warmup.lock
```

Authentication failures, retry exhaustion, configuration failures, and an
uncertain timeout exit nonzero and leave the checkpoint for inspection. After
an uncertain timeout, inspect the web logs and wait at least five minutes before
resuming so the server-side request cannot overlap a retry.

Once the scanner exits successfully with `bounded:false` and `stopped:false`,
restore only the profile-sync timers that were enabled and active before the
pilot. Do not start an additional manual scanner. Leave the checkpoint in
`/data` for audit and resume behavior until the rollout is accepted.

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
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web node -e \
  'fetch("http://127.0.0.1:3000/api/leaderboard?mode=regular&sort=primary").then(async r=>{if(!r.ok)throw new Error(await r.text());console.log(await r.text())})'
docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web \
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
  docker compose -p tarkovstats -f docker-compose.vps.yml exec -T web \
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

The one-scope result does not establish memory or disk headroom on a 2 GiB VPS.
The production container is limited to 1 GiB and shares the host with Caddy,
Docker, the kernel, every source database, and every leaderboard scope. Treat
the WAL-consistent backup and full multi-scope copy run above as a rollout gate,
then compare its measured peak and final database size with the host's current
free memory and disk before installing or enabling the timer.
