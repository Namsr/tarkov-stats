#!/bin/sh
# Онлайн-консистентный бэкап players.db: VACUUM INTO в volume (доступен на
# хосте через mountpoint), затем gzip на хост и ротация старше 14 дней.
# docker cp не используется намеренно — он не читает из tmpfs.
set -e
DIR=/opt/tarkovstats/backups
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)
VOL=$(docker volume inspect -f '{{.Mountpoint}}' tarkovstats_players_data)

# Подчистка возможного хвоста от прерванного прогона.
find "$VOL" -name pdb-backup.db -delete 2>/dev/null || true

docker exec tarkovstats-web-1 node --experimental-sqlite -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/players.db");d.exec("VACUUM INTO '"'"'/data/pdb-backup.db'"'"'");d.close();'

gzip -c "$VOL/pdb-backup.db" > "$DIR/players-$TS.db.gz"
find "$VOL" -name pdb-backup.db -delete

# Ротация: бэкапы старше 14 дней удаляем (find -delete, без rm).
find "$DIR" -name 'players-*.db.gz' -mtime +14 -delete
echo "backup done: $DIR/players-$TS.db.gz"
