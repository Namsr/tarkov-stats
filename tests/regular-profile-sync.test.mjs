import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createTimestampObjectParser,
  normalizeUpdatedAt,
  summarizeCoverage,
} from "../scripts/regular-profile-sync-core.mjs";

test("updated feed parser streams aid-to-version objects across arbitrary chunks", () => {
  const json = '{"13134885":1720000000000,"42":"1720000001"}';
  const entries = [];
  const parser = createTimestampObjectParser((aid, version) => entries.push([aid, version]));
  for (const character of json) parser.append(character);
  parser.finish();
  assert.deepEqual(entries, [
    ["13134885", 1720000000000],
    ["42", "1720000001"],
  ]);
  assert.equal(normalizeUpdatedAt(entries[1][1]), 1720000001000);
  assert.equal(normalizeUpdatedAt(0), null);
});

test("regular sync 404 path records not_found without ban or player deletion", async () => {
  const source = await readFile(new URL("../scripts/sync-regular-profiles.mjs", import.meta.url), "utf8");
  assert.match(source, /response\.status === 404/);
  assert.match(source, /kind: "not_found"/);
  assert.doesNotMatch(source, /confirmBanned|DELETE FROM players\b/);
});

test("coverage uses every tracked non-excluded regular profile", async () => {
  const source = await readFile(new URL("../scripts/sync-regular-profiles.mjs", import.meta.url), "utf8");
  assert.match(source, /WHERE e\.aid IS NULL/);
  assert.match(source, /profile_updated_at > 0/);
  assert.match(source, /missingFromFeed: Math\.max\(0, coverageSummary\.coverageTotal - trackedNonExcludedInFeed\)/);
  assert.doesNotMatch(source, /const coverageTotal = feed\.trackedInFeed/);
});

test("coverage summary keeps exact unresolved counts below one hundred percent", () => {
  assert.deepEqual(summarizeCoverage(50_986, 50_985), {
    coverageTotal: 50_986,
    covered: 50_985,
    unresolved: 1,
    coveragePercent: 99.998,
  });
  assert.equal(summarizeCoverage(2_000_000, 1_999_999).coveragePercent, 99.9999);
  assert.equal(summarizeCoverage(50_986, 50_986).coveragePercent, 100);
});
