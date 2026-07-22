#!/bin/sh
# Онлайн-консистентный бэкап всех SQLite-файлов: VACUUM INTO в volume
# (доступен на хосте через mountpoint), затем gzip на хост и ротация старше 14 дней.
# docker cp не используется намеренно — он не читает из tmpfs.
set -e
DIR=/opt/tarkovstats/backups
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
VOL=$(docker volume inspect -f '{{.Mountpoint}}' tarkovstats_players_data)

# Подчистка возможных хвостов от прерванного прогона.
find "$VOL" -name '*-backup.db' -delete 2>/dev/null || true

docker exec tarkovstats-web-1 node --experimental-sqlite -e 'const fs=require("node:fs");const{DatabaseSync}=require("node:sqlite");for(const n of ["players","bans","progression","community-reports"]){const src=`/data/${n}.db`;if(!fs.existsSync(src))continue;const d=new DatabaseSync(src);d.exec(`VACUUM INTO '"'"'/data/${n}-backup.db'"'"'`);d.close();}'

BACKED_UP=""
for NAME in players bans progression community-reports; do
  SNAPSHOT="$VOL/$NAME-backup.db"
  if [ -f "$SNAPSHOT" ]; then
    gzip -c "$SNAPSHOT" > "$DIR/$NAME-$TS.db.gz"
    BACKED_UP="$BACKED_UP $DIR/$NAME-$TS.db.gz"
  fi
done
find "$VOL" -name '*-backup.db' -delete

# Ротация: бэкапы старше 14 дней удаляем (find -delete, без rm).
for NAME in players bans progression community-reports; do
  find "$DIR" -name "$NAME-*.db.gz" -mtime +14 -delete
done
echo "backup done:$BACKED_UP"
