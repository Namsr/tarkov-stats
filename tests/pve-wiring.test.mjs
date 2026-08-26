import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("PvE sync scripts stay one-shot commands for systemd", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const dockerfile = await readFile("Dockerfile", "utf8");
  const startup = await readFile("scripts/start-web.mjs", "utf8");

  assert.equal(
    packageJson.scripts["sync:pve-index"],
    "node --experimental-strip-types --experimental-sqlite scripts/sync-pve-index.mjs",
  );
  assert.equal(
    packageJson.scripts["sync:pve-profiles"],
    "node --experimental-strip-types --experimental-sqlite scripts/sync-pve-profiles.mjs",
  );
  assert.equal(packageJson.scripts["sync:player-indexes-loop"], undefined);
  assert.match(dockerfile, /COPY --from=builder --chown=nextjs:nodejs \/app\/scripts\/sync-pve-index\.mjs \.\/scripts\/sync-pve-index\.mjs/);
  assert.match(dockerfile, /COPY --from=builder --chown=nextjs:nodejs \/app\/scripts\/sync-pve-profiles\.mjs \.\/scripts\/sync-pve-profiles\.mjs/);
  assert.match(dockerfile, /COPY --from=builder --chown=nextjs:nodejs \/app\/lib\/pve-progression-seed-core\.ts \.\/lib\/pve-progression-seed-core\.ts/);
  assert.doesNotMatch(dockerfile, /sync-player-indexes-loop\.mjs|sync-seasonal-feed-loop\.mjs/);
  assert.doesNotMatch(startup, /sync-player-indexes-loop\.mjs|sync-seasonal-feed-loop\.mjs/);
});

test("PvE systemd units use offset Moscow schedules and the shared writer lock", async () => {
  const profileTimer = await readFile("ops/systemd/tarkovstats-pve-profile-sync.timer", "utf8");
  const indexTimer = await readFile("ops/systemd/tarkovstats-pve-index-sync.timer", "utf8");
  const profileService = await readFile("ops/systemd/tarkovstats-pve-profile-sync.service", "utf8");
  const indexService = await readFile("ops/systemd/tarkovstats-pve-index-sync.service", "utf8");

  assert.match(profileTimer, /Description=Hourly TarkovStats PvE profile sync/);
  assert.match(profileTimer, /OnCalendar=\*-\*-\* \*:40:00 Europe\/Moscow/);
  assert.match(indexTimer, /OnCalendar=\*-\*-\* 00:20:00 Europe\/Moscow/);
  assert.doesNotMatch(profileTimer + indexTimer, /RandomizedDelaySec/);
  assert.match(profileService, /Description=TarkovStats PvE profile feed sync/);
  assert.match(indexService, /Description=TarkovStats daily PvE player nickname index sync/);
  assert.match(profileService, /TimeoutStartSec=14m/);
  assert.match(indexService, /TimeoutStartSec=14h/);
  for (const service of [profileService, indexService]) {
    assert.match(service, /ConditionPathExists=\/opt\/tarkovstats\/docker-compose\.vps\.yml/);
    assert.match(service, /WorkingDirectory=\/opt\/tarkovstats/);
    assert.match(service, /docker compose -f docker-compose\.vps\.yml exec -T web node/);
    assert.match(service, /ExecCondition=\/bin\/sh -c '! \/usr\/bin\/docker container inspect tarkovstats-public-profile-importer/);
    assert.match(service, /\/run\/tarkovstats-data-sync\.lock/);
  }
  assert.match(profileService, /flock -n \/run\/tarkovstats-data-sync\.lock/);
  assert.match(indexService, /flock \/run\/tarkovstats-data-sync\.lock/);
  assert.doesNotMatch(indexService, /flock -n/);
  assert.match(profileService, /scripts\/sync-pve-profiles\.mjs/);
  assert.match(indexService, /scripts\/sync-pve-index\.mjs/);
});

test("PvE no-attempt runs reuse the pre-processing coverage snapshot", async () => {
  const source = await readFile("scripts/sync-pve-profiles.mjs", "utf8");
  assert.match(source, /const \{ counters: feed, coverage: preProcessingCoverage \} = await loadFeed\(\);/);
  assert.match(source, /processed\.attempted === 0 \? preProcessingCoverage : db\.prepare/);
});
