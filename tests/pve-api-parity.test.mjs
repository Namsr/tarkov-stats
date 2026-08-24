import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [profile, cohort, average, progressionAverage, db] = await Promise.all([
  readFile("app/api/player/profile/route.ts", "utf8"),
  readFile("app/api/average/cohort/route.ts", "utf8"),
  readFile("app/api/average/route.ts", "utf8"),
  readFile("app/api/progression/average/route.ts", "utf8"),
  readFile("lib/db.ts", "utf8"),
]);

test("PvE profile responses use the PvE portrait, risk, baseline, and snapshot stream", () => {
  const pveBranch = profile.slice(profile.lastIndexOf('if (mode === "pve") {'));
  assert.match(pveBranch, /pveProfileDecision\(profile\)/);
  assert.match(pveBranch, /persistRegularProfileSnapshot\(pveSnapshot, \{[\s\S]*?mode: "pve"/);
  assert.match(profile, /buildPersistentProfileViewModel\(\{[\s\S]*?mode: "pve"/);
  assert.match(profile, /getRiskEvaluation\(\{ aid, mode: "pve", cycleId \}\)/);
  assert.match(profile, /comparisonStats: buildPersistentComparisonStats\(input\.stats\)/);
  assert.match(profile, /capture: input\.capture/);
  assert.match(profile, /enrichPersistentViewModel\("pve", buildPersistentProfileViewModel/);
  assert.match(profile, /loadPersistentAchievementBaseline\(mode\)/);
  assert.match(profile, /getAchievements\("regular"\)/);
  assert.doesNotMatch(pveBranch, /getStore\("regular"\)/);
});

test("PvE averages and cohorts accept all and 90d without client supplied centers", () => {
  assert.match(average, /rawMode !== "regular" && rawMode !== "pve" && period !== "all"/);
  assert.match(cohort, /rawMode !== "regular" && rawMode !== "pve" && period !== "all"/);
  const persistentBranch = cohort.slice(
    cohort.indexOf('if (rawMode === "regular" || rawMode === "pve")'),
    cohort.indexOf("  const dimension", cohort.indexOf('if (rawMode === "regular" || rawMode === "pve")')),
  );
  assert.match(persistentBranch, /getPublicProfile\(aid, \{ mode \}\)/);
  assert.match(persistentBranch, /getStore\(mode\)/);
  assert.match(persistentBranch, /store\.cohort2d\(/);
  assert.doesNotMatch(persistentBranch, /params\.get\("center"\)/);
  assert.match(db, /mode: Extract<CrossSectionMode, "regular" \| "pve">/);
  assert.doesNotMatch(db, /if \(mode !== "regular" \|\| period === "all"\) return active/);
});

test("PvE average progression has a separate mode cache", () => {
  assert.match(progressionAverage, /getPersistentProgressionAverage\("pve"\)/);
  assert.match(progressionAverage, /\["average-progression-pve-v1"\]/);
  assert.match(progressionAverage, /mode !== "regular" && mode !== "pve"/);
});
