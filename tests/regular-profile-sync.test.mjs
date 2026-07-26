import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createTimestampObjectParser, normalizeUpdatedAt } from "../scripts/regular-profile-sync-core.mjs";

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
  assert.match(source, /missingFromFeed: Math\.max\(0, coverageTotal - trackedNonExcludedInFeed\)/);
  assert.doesNotMatch(source, /const coverageTotal = feed\.trackedInFeed/);
});
