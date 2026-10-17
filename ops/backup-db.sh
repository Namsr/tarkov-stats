#!/bin/sh
# Install as /opt/tarkovstats/backup-db.sh. Keep one verified database backup set.
set -eu
umask 077
DIR=/opt/tarkovstats/backups
DATABASES='players bans progression community-reports admin-analytics'

# Read-only age probe for operators and the backup service's postcondition.
latest=0
for marker in "$DIR"/backup-*/.complete; do
  [ -f "$marker" ] && [ ! -L "$marker" ] || continue
  completed=$(stat -c %Y "$marker")
  [ "$completed" -le "$latest" ] || latest=$completed
done
now=$(date +%s)
age=$(( now - latest ))
printf 'BACKUP_STATUS at=%s latest_completed=%s age_seconds=%s\n' "$now" "$latest" "$age"
if [ "${1:-}" = --check-age ]; then
  [ "$latest" -gt 0 ] && [ "$age" -ge 0 ] && [ "$age" -le 129600 ]
  exit $?
fi
[ "$#" -eq 0 ] || { echo 'unknown backup argument' >&2; exit 64; }

# Children on the host inherit the lowest CPU and idle I/O priorities.
renice -n 19 -p "$$" >/dev/null
ionice -c 3 -p "$$"
mkdir -p "$DIR"
exec 9>"$DIR/.backup.lock"
flock -n 9 || { echo 'backup already running' >&2; exit 0; }
# Wait rather than skip today's backup. Use the same order for shared locks:
# deploy/profile queue first, then the standalone leaderboard job.
exec 8>/run/tarkovstats-data-sync.lock
flock 8
exec 7>/run/tarkovstats-leaderboard.lock
flock 7

VOL=$(docker volume inspect -f '{{.Mountpoint}}' tarkovstats_players_data)
[ -d "$VOL" ] && [ "$VOL" != / ] || { echo 'invalid backup volume' >&2; exit 1; }
SNAPSHOT="$VOL/.tarkovstats-backup.db"
STAGE="$DIR/.tarkovstats-backup-pending"
FINAL="$DIR/backup-$(date +%Y%m%d-%H%M%S)-$$"

cleanup() {
  rm -f -- "$SNAPSHOT" "$SNAPSHOT.gz" "$SNAPSHOT-journal" "$SNAPSHOT-wal" "$SNAPSHOT-shm"
  if [ -d "$STAGE" ] && [ ! -L "$STAGE" ]; then
    for name in $DATABASES; do rm -f -- "$STAGE/$name.db.gz"; done
    rm -f -- "$STAGE/.complete"
    rmdir -- "$STAGE"
  fi
}
[ ! -L "$STAGE" ] || { echo 'invalid staging directory' >&2; exit 1; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cleanup
mkdir "$STAGE"

for NAME in $DATABASES; do
  database_bytes=$(stat -c %s "$VOL/$NAME.db")
  wal_bytes=0
  source_bytes=$database_bytes
  if [ -f "$VOL/$NAME.db-wal" ]; then
    wal_bytes=$(stat -c %s "$VOL/$NAME.db-wal")
    source_bytes=$(( source_bytes + wal_bytes ))
  fi
  available_kb=$(df -Pk "$VOL" | awk 'NR == 2 { print $4 }')
  # Reserve the snapshot first. Compression checks actual free space on every
  # output chunk rather than rejecting a small archive as another full database.
  required_kb=$(( (source_bytes + 1023) / 1024 + 1048576 ))
  printf 'BACKUP_SPACE at=%s database=%s db_bytes=%s wal_bytes=%s available_kb=%s required_kb=%s\n' "$(date +%s)" "$NAME" "$database_bytes" "$wal_bytes" "$available_kb" "$required_kb"
  if [ "$available_kb" -lt "$required_kb" ]; then
    echo "insufficient free space for $NAME backup; retaining previous set" >&2
    exit 1
  fi
  # SQLite snapshots use the same bounded offline service, independently of HTTP.
  /usr/local/sbin/tarkovstats-run-background worker nice -n 19 ionice -c 3 node --experimental-sqlite -e '
    const fs = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    const name = process.argv[1];
    const source = `/data/${name}.db`;
    const target = "/data/.tarkovstats-backup.db";
    if (!fs.existsSync(source)) throw new Error(`Missing backup database: ${name}`);
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.prepare("VACUUM INTO ?").run(target);
    } finally { db.close(); }
    const snapshot = new DatabaseSync(target, { readOnly: true });
    try {
      const rows = snapshot.prepare("PRAGMA quick_check").all();
      if (rows.length !== 1 || rows[0].quick_check !== "ok") {
        throw new Error(`Invalid backup database: ${name}`);
      }
    } finally { snapshot.close(); }
    const { createGzip } = require("node:zlib");
    const output = fs.openSync(target + ".gz", "wx", 0o600);
    (async () => {
      const source = fs.createReadStream(target);
      const input = createGzip();
      source.on("error", error => input.destroy(error));
      source.pipe(input);
      try {
        for await (const chunk of input) {
          const space = fs.statfsSync(target);
          if (space.bavail * space.bsize < 1024 * 1024 * 1024 + chunk.length) {
            throw new Error("insufficient free space during backup compression; retaining previous set");
          }
          let offset = 0;
          while (offset < chunk.length) offset += fs.writeSync(output, chunk, offset, chunk.length - offset);
        }
      } finally { source.destroy(); input.destroy(); fs.closeSync(output); }
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  ' "$NAME"
  mv -- "$SNAPSHOT.gz" "$STAGE/$NAME.db.gz"
  gzip -t "$STAGE/$NAME.db.gz"
  rm -f -- "$SNAPSHOT"
done

# Publish the whole verified set before removing any previous backup.
touch "$STAGE/.complete"
mv -T -- "$STAGE" "$FINAL"
for OLD in "$DIR"/backup-*; do
  [ -d "$OLD" ] && [ ! -L "$OLD" ] && [ -f "$OLD/.complete" ] || continue
  [ "$OLD" != "$FINAL" ] || continue
  for NAME in $DATABASES; do rm -f -- "$OLD/$NAME.db.gz"; done
  rm -f -- "$OLD/.complete"
  rmdir -- "$OLD"
done
# Remove former flat database archives only after the new set is verified.
find "$DIR" -maxdepth 1 -type f -regextype posix-extended \
  -regex '.*/(players|bans|progression|community-reports|admin-analytics)-[0-9]{8}-[0-9]{6}\.db\.gz' -delete
printf 'backup done: %s\n' "$FINAL"
