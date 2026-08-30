import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner resolves the explicit .ts module.
import { buildWeaponMasteryRows, displayedWeaponMasteryProgress, normalizeWeaponMastery, parseWeaponMastery, sortWeaponMastery, weaponMasteryLevel } from "../lib/profile-mastery.ts";
// @ts-expect-error Node's strip-types test runner resolves the explicit .ts module.
import { parseProfileStats } from "../lib/tarkov-api.ts";

test("weapon mastery parser validates handbook rows and level boundaries", () => {
  const references = parseWeaponMastery({ data: { mastering: [
    { id: "mastering-ak", weapons: ["AK-74"], level2: 100, level3: 300 },
  ] } });
  assert.equal(weaponMasteryLevel(99, references[0]), 1);
  assert.equal(weaponMasteryLevel(100, references[0]), 2);
  assert.equal(weaponMasteryLevel(299, references[0]), 2);
  assert.equal(weaponMasteryLevel(300, references[0]), 3);
  assert.throws(() => parseWeaponMastery({ data: { mastering: [
    { id: "bad", weapons: [], level2: 4, level3: 3 },
  ] } }));
});

test("profile parsing retains normalized Mastering rows for stats_json", () => {
  const stats = parseProfileStats({
    aid: 42,
    info: { nickname: "Mastery", side: "Usec", experience: 0 },
    skills: {
      Common: [{ Id: "Endurance", Progress: 4, LastAccess: 123, PointsEarnedDuringSession: 0 }],
      Mastering: [
        { Id: "AK", Progress: 12 },
        { Id: "bad", Progress: -1 },
      ],
    },
    achievements: { first_raid: 456 },
  });
  assert.deepEqual(stats.weaponMastery, [{ id: "AK", progress: 12 }]);
  assert.deepEqual(stats.commonSkills, [{ Id: "Endurance", Progress: 4, LastAccess: 123, PointsEarnedDuringSession: 0 }]);
  assert.deepEqual(stats.achievementUnlocks, { first_raid: 456 });
});

test("weapon mastery normalizes profile rows, joins names, and sorts progress descending", () => {
  const references = [
    { id: "ak", weapons: ["AK-74"], level2: 10, level3: 20 },
    { id: "sr", weapons: ["SR-2"], level2: 10, level3: 20 },
  ];
  const progress = normalizeWeaponMastery([
    { Id: "ak", Progress: 20 },
    { Id: "sr", Progress: 10 },
    { Id: "invalid", Progress: -1 },
    { Id: "ak", Progress: 1 },
  ]);
  const rows = buildWeaponMasteryRows(progress, references);
  assert.deepEqual(rows.map((row) => [row.weapon, row.progress, row.level]), [
    ["ak", 20, 3], ["sr", 10, 2],
  ]);
  assert.deepEqual(sortWeaponMastery(rows).map((row) => row.id), ["ak", "sr"]);
  assert.deepEqual(sortWeaponMastery(rows, "progress", "asc").map((row) => row.id), ["sr", "ak"]);
  assert.deepEqual(sortWeaponMastery(rows, "weapon", "asc").map((row) => row.id), ["ak", "sr"]);
  assert.deepEqual(sortWeaponMastery(rows, "weapon", "desc").map((row) => row.id), ["sr", "ak"]);
  assert.deepEqual(sortWeaponMastery([
    { id: "level1", weapon: "A", progress: 999, level: 1 },
    { id: "level3", weapon: "B", progress: 1, level: 3 },
  ]).map((row) => row.id), ["level3", "level1"]);
});

test("weapon mastery table exposes sortable headers and a mobile list", () => {
  const source = readFileSync("components/ProfileMastering.tsx", "utf8");
  assert.match(source, /aria-sort=\{ariaSortValue/);
  assert.match(source, /className="mastering-table__sort/);
  assert.match(source, /<caption className="sr-only">/);
  assert.match(source, /className="mastering-cards" role="list"/);
  assert.match(source, /displayedWeaponMasteryProgress\(progress\)\.toLocaleString/);
  assert.match(source, /const positiveRows = sorted\.filter\(\(row\) => displayedWeaponMasteryProgress\(row\.progress\) > 0\)/);
  assert.match(source, /const zeroRows = sorted\.filter\(\(row\) => displayedWeaponMasteryProgress\(row\.progress\) === 0\)/);
  assert.match(source, /const showZeroTail = !positiveCanCollapse \|\| positiveExpanded/);
  assert.match(source, /if \(positiveExpanded\) setZeroExpanded\(false\)/);
  assert.match(source, /previewCount=\{MASTERY_PREVIEW_COUNT\}/);
  assert.match(source, /collapsed=\{positiveCanCollapse && !positiveExpanded\}/);
  assert.match(source, /aria-hidden=\{collapsed && previewCount !== undefined && index > previewCount/);
  assert.match(source, /aria-expanded=\{positiveExpanded\}/);
  assert.match(source, /aria-controls=\{positivePanelId\}/);
  assert.match(source, /mastering\.zeroExpand/);
  assert.match(source, /profile-collapsible__preview-tail/);
});

test("mastery rows use the displayed rounded value for zero partitioning", () => {
  assert.equal(displayedWeaponMasteryProgress(0.49), 0);
  assert.equal(displayedWeaponMasteryProgress(0.5), 1);
});

test("all profile modes wire mastery from API through their UI shells", () => {
  const route = readFileSync("app/api/player/profile/route.ts", "utf8");
  const regular = readFileSync("components/RegularPlayer.tsx", "utf8");
  const seasonal = readFileSync("components/SeasonalPlayer.tsx", "utf8");
  const shell = readFileSync("components/ProfileShell.tsx", "utf8");

  assert.match(route, /enrichRegularViewModel[\s\S]*?enrichPersistentViewModel\("regular"/);
  assert.match(route, /enrichPersistentViewModel\("pve"/);
  assert.match(route, /async function enrichSeasonalViewModel[\s\S]*?buildWeaponMasteryRows\(viewModel\.mastering\.items, masteryReferences\)/);
  assert.match(regular, /if \(mode === "regular" \|\| mode === "pve"\)[\s\S]*?mastering=\{hasVisibleMastery\(masteryItems\) \? <ProfileMastering items=\{masteryItems\} \/>/);
  assert.match(seasonal, /masteryFromViewModel[\s\S]*?mastering=\{hasVisibleMastery\(masteryItems\) \? <ProfileMastering items=\{masteryItems\} \/>/);

  const sectionOrder = shell.match(/const SECTION_IDS = \[([\s\S]*?)\] as const/)?.[1] ?? "";
  assert.ok(sectionOrder.indexOf("\"achievements\"") < sectionOrder.indexOf("\"mastering\""));
  assert.ok(sectionOrder.indexOf("\"mastering\"") < sectionOrder.indexOf("\"skills\""));
});
