import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifySeasonalVersion,
  createStringObjectParser,
  createTimestampObjectParser,
  normalizeAid,
  normalizeNickname,
} from "../scripts/seasonal-profile-sync-core.mjs";

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
});

test("Seasonal collectors use the authenticated capture endpoint and JSON helper", async () => {
  const profileSource = await readFile("scripts/sync-seasonal-profiles.mjs", "utf8");
  const indexSource = await readFile("scripts/sync-seasonal-index.mjs", "utf8");
  assert.match(profileSource, /fetchTarkovJson/);
  assert.match(indexSource, /fetchTarkovJson/);
  assert.match(profileSource, /\/api\/operator\/seasonal\/profile-sync/);
  assert.match(profileSource, /feed_updated_at/);
  assert.match(profileSource, /superseded/);
  assert.match(profileSource + indexSource, /isSeasonalCollectorReady/);
  assert.doesNotMatch(profileSource + indexSource, /isSeasonalRolloutReady/);
  assert.doesNotMatch(profileSource + indexSource, /api\.tarkov\.dev\/graphql|\bgraphql\b/i);
});

test("Docker runtime contains the Seasonal collectors and their source imports", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  for (const path of [
    "scripts/sync-seasonal-profiles.mjs",
    "scripts/sync-seasonal-index.mjs",
    "scripts/seasonal-profile-sync-core.mjs",
    "scripts/regular-profile-sync-core.mjs",
    "lib/tarkov-api.ts",
    "lib/seasonal/config.ts",
    "lib/seasonal/storage.ts",
  ]) assert.match(dockerfile, new RegExp(path.replaceAll("/", "\\/")), path);
});

test("Seasonal timers use the requested Moscow cadence and shared waiting lock", async () => {
  const feedTimer = await readFile("ops/systemd/tarkovstats-seasonal-profile-sync.timer", "utf8");
  const indexTimer = await readFile("ops/systemd/tarkovstats-seasonal-index-sync.timer", "utf8");
  const feedService = await readFile("ops/systemd/tarkovstats-seasonal-profile-sync.service", "utf8");
  const indexService = await readFile("ops/systemd/tarkovstats-seasonal-index-sync.service", "utf8");
  assert.match(feedTimer, /OnCalendar=\*-\*-\* \*:07,22,37,52:00 Europe\/Moscow/);
  assert.match(indexTimer, /OnCalendar=\*-\*-\* 00:00:00 Europe\/Moscow/);
  assert.match(feedService, /flock -n \/run\/tarkovstats-seasonal-sync\.lock/);
  assert.match(indexService, /flock \/run\/tarkovstats-seasonal-sync\.lock/);
});
