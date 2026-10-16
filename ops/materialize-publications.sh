#!/bin/sh
# Daily, sequential refresh. A failed scope leaves the last-good generation live.
set -u
status=0
/usr/local/sbin/tarkovstats-run-background -e AVERAGE_MATERIALIZE_ONCE=true \
  worker nice -n 19 node --experimental-strip-types --experimental-sqlite \
  --experimental-loader ./scripts/ts-alias-loader.mjs scripts/materialize-average-publications.mjs || status=1
/usr/local/sbin/tarkovstats-run-background -e PROGRESSION_MATERIALIZE_ONCE=true \
  worker nice -n 19 node --experimental-strip-types --experimental-sqlite \
  scripts/materialize-progression-population.mjs || status=1
exit "$status"
