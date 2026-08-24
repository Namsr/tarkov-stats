import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifySeasonalVersion,
  createStringObjectParser,
  createTimestampObjectParser,
  enqueueMissingSeasonalIndexProfiles,
  normalizeAid,
  normalizeNickname,
  seasonalIndexCacheUrl,
} from "../scripts/seasonal-profile-sync-core.mjs";
import { DatabaseSync } from "node:sqlite";

test("Seasonal updated parser streams versions and normalizes timestamps", () => {
  const entries = [];
  const parser = createTimestampObjectParser((aid, updatedAt) => entries.push([aid, updatedAt]));
  for (const chunk of ['{"7":1700000000', ',"8":"1700000001000"}']) parser.append(chunk);
  parser.finish();
  assert.deepEqual(entries, [["7", 1700000000], ["8", "1700000001000"]]);
  assert.equal(classifySeasonalVersion(1700000000000, 1700000000000), "current");
  assert.equal(classifySeasonalVersion(1700000000000, 1700000001000), "superseded");
  assert.equal(classifySeasonalVersion(1700000001000, 1700000000000), "stale");
});

test("Seasonal index parser accepts only nickname strings", () => {
  const entries = [];
  const parser = createStringObjectParser((aid, nickname) => entries.push([aid, nickname]));
  for (const chunk of ['{"7":"Alpha', '","8":"Bad Nick"}']) parser.append(chunk);
  parser.finish();
  assert.deepEqual(entries, [["7", "Alpha"], ["8", "Bad Nick"]]);
  assert.equal(normalizeAid("7"), 7);
  assert.equal(normalizeAid("0"), null);
  assert.equal(normalizeNickname("Alpha"), "Alpha");
  assert.equal(normalizeNickname("Bad Nick"), null);
  assert.equal(
    seasonalIndexCacheUrl("https://players.tarkov.dev/pvp-season/index.json", 15 * 60_000),
    "https://players.tarkov.dev/pvp-season/index.json?v=1",
  );
});

test("Seasonal index entries without snapshots are queued exactly once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE seasonal_player_index (
      cycle_id TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid)
    );
    CREATE TABLE seasonal_profile_sync_queue (
      cycle_id TEXT NOT NULL, aid INTEGER NOT NULL, feed_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid, feed_updated_at)
    );
    CREATE TABLE progression_snapshots (mode TEXT, cycle_id TEXT, aid INTEGER);
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    INSERT INTO seasonal_player_index VALUES
      ('s1', 1, 'One', 'one', 10), ('s1', 2, 'Two', 'two', 10), ('s1', 3, 'Three', 'three', 10);
    INSERT INTO progression_snapshots VALUES ('seasonal', 's1', 1);
    INSERT INTO excluded_players VALUES (3);
  `);
  assert.deepEqual(enqueueMissingSeasonalIndexProfiles(db, "s1", 100, 200), {
    indexEntries: 3,
    indexedMissingQueued: 1,
  });
  assert.deepEqual(enqueueMissingSeasonalIndexProfiles(db, "s1", 100, 300), {
    indexEntries: 3,
    indexedMissingQueued: 0,
  });
  const queued = db.prepare("SELECT aid, feed_updated_at, status FROM seasonal_profile_sync_queue")
    .all().map((row) => ({ ...row }));
  assert.deepEqual(queued, [
    { aid: 2, feed_updated_at: 100, status: "pending" },
  ]);
  db.close();
});

test("Seasonal collectors use the authenticated capture endpoint and JSON helper", async () => {
  const profileSource = await readFile("scripts/sync-seasonal-profiles.mjs", "utf8");
  const indexSource = await readFile("scripts/sync-seasonal-index.mjs", "utf8");
  assert.match(profileSource, /fetchTarkovJson/);
  assert.match(indexSource, /fetchTarkovJson/);
  assert.match(profileSource, /\/api\/operator\/seasonal\/profile-sync/);
  assert.match(profileSource, /feed_updated_at/);
  assert.match(profileSource, /enqueueMissingSeasonalIndexProfiles/);
  assert.match(profileSource, /superseded/);
  assert.match(profileSource + indexSource, /isSeasonalCollectorReady/);
  assert.doesNotMatch(profileSource + indexSource, /isSeasonalRolloutReady/);
  assert.doesNotMatch(profileSource + indexSource, /api\.tarkov\.dev\/graphql|\bgraphql\b/i);
});

test("Seasonal capture invalidates the average cache only after an inserted profile", async () => {
  const source = await readFile("app/api/operator/seasonal/profile-sync/route.ts", "utf8");

  assert.match(source, /if \(result\.capture\.inserted === true\) \{\s*revalidateTag\(SEASONAL_AVERAGE_CACHE_TAG, \{ expire: 0 \}\);/s);
  assert.equal((source.match(/revalidateTag\(/g) ?? []).length, 1);
  assert.ok(
    source.indexOf("if (!result.ok)") < source.indexOf("if (result.capture.inserted === true)"),
    "failed captures must not invalidate the cache",
  );
  assert.ok(
    source.indexOf("result.capture.inserted === true") < source.indexOf("return Response.json({", source.indexOf("result.capture.inserted === true")),
    "duplicate/no-op captures must return through the normal response path without invalidation",
  );
});

test("Docker runtime contains the Seasonal collectors and their source imports", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const startup = await readFile("scripts/start-web.mjs", "utf8");
  for (const path of [
    "scripts/sync-seasonal-profiles.mjs",
    "scripts/sync-seasonal-index.mjs",
    "scripts/seasonal-profile-sync-core.mjs",
    "scripts/regular-profile-sync-core.mjs",
    "lib/tarkov-api.ts",
    "lib/seasonal/config.ts",
    "lib/seasonal/storage.ts",
  ]) assert.match(dockerfile, new RegExp(path.replaceAll("/", "\\/")), path);
  assert.doesNotMatch(startup, /sync-seasonal-feed-loop\.mjs|sync-player-indexes-loop\.mjs/);
});

test("Seasonal timers use the requested Moscow cadence and shared waiting lock", async () => {
  const feedTimer = await readFile("ops/systemd/tarkovstats-seasonal-profile-sync.timer", "utf8");
  const indexTimer = await readFile("ops/systemd/tarkovstats-seasonal-index-sync.timer", "utf8");
  const feedService = await readFile("ops/systemd/tarkovstats-seasonal-profile-sync.service", "utf8");
  const indexService = await readFile("ops/systemd/tarkovstats-seasonal-index-sync.service", "utf8");
  assert.match(feedTimer, /OnCalendar=\*-\*-\* \*:07,22,37,52:00 Europe\/Moscow/);
  assert.match(indexTimer, /OnCalendar=\*-\*-\* 00:10:00 Europe\/Moscow/);
  assert.match(feedService, /flock -n \/run\/tarkovstats-seasonal-sync\.lock/);
  assert.match(indexService, /flock \/run\/tarkovstats-seasonal-sync\.lock/);
  assert.match(feedService, /ConditionPathExists=\/opt\/tarkovstats-auto\/docker-compose\.vps\.yml/);
  assert.match(feedService, /WorkingDirectory=\/opt\/tarkovstats-auto/);
  assert.match(indexService, /ConditionPathExists=\/opt\/tarkovstats-auto\/docker-compose\.vps\.yml/);
  assert.match(indexService, /WorkingDirectory=\/opt\/tarkovstats-auto/);
});
