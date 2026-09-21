import assert from "node:assert/strict";
import test from "node:test";
import {
  compareAchievementScarcity,
  localizedAchievementDescription,
  localizedAchievementName,
  rarestAchievements,
  sortProfileAchievements,
  type ProfileAchievementItem,
// @ts-expect-error -- Node's strip-types test runner resolves the explicit .ts module.
} from "../lib/profile-achievements.ts";

const achievement = (id: string, unlockedAt: number | null, name: string, rarity = "common"): ProfileAchievementItem => ({
  id,
  unlockedAt,
  earlyHours: null,
  unlockHours: null,
  name,
  nameRu: null,
  description: null,
  descriptionRu: null,
  imageUrl: null,
  rarity,
  owners: null,
  eligibleN: null,
  percentage: null,
  officialPercentage: null,
  officialCategory: null,
});

test("achievement date sort defaults to newest and keeps missing dates last", () => {
  const rows = [
    achievement("old", 1_700_000_000_000, "Old"),
    achievement("missing", null, "Missing"),
    achievement("new", 1_800_000_000_000, "New"),
  ];
  assert.deepEqual(sortProfileAchievements(rows), [rows[2], rows[0], rows[1]]);
  assert.deepEqual(sortProfileAchievements(rows, "date", "asc"), [rows[0], rows[2], rows[1]]);
});

test("achievement hours sort uses the display unlock percentile and keeps missing values last", () => {
  const rows = [
    { ...achievement("late", null, "Late"), earlyHours: 10, unlockHours: 900 },
    { ...achievement("missing", null, "Missing"), earlyHours: 5, unlockHours: null },
    { ...achievement("early", null, "Early"), earlyHours: 1_000, unlockHours: 20 },
  ];
  assert.deepEqual(sortProfileAchievements(rows, "hours", "asc").map((row) => row.id), ["early", "late", "missing"]);
  assert.deepEqual(sortProfileAchievements(rows, "hours", "desc").map((row) => row.id), ["late", "early", "missing"]);
});

test("achievement alphabet sort honors the requested locale", () => {
  const rows = [
    { ...achievement("ru", 2, "Alpha"), nameRu: "Бета" },
    { ...achievement("en", 1, "Zulu"), nameRu: "Альфа" },
  ];
  assert.deepEqual(sortProfileAchievements(rows, "alphabet", "asc", "ru").map((row) => row.id), ["en", "ru"]);
  assert.equal(localizedAchievementName(rows[0], "ru"), "Бета");
});

test("achievement percent sort uses our sample first, then BSG, with missing values last", () => {
  const rows = [
    { ...achievement("missing", 1, "Missing"), officialPercentage: null },
    { ...achievement("official", 2, "Official"), officialPercentage: 10 },
    { ...achievement("sample", 3, "Sample"), percentage: 2, officialPercentage: 90 },
    { ...achievement("sample-high", 4, "Sample high"), percentage: 20, officialPercentage: null },
  ];
  assert.deepEqual(sortProfileAchievements(rows, "percent", "asc").map((row) => row.id), ["sample", "official", "sample-high", "missing"]);
  assert.deepEqual(sortProfileAchievements(rows, "percent", "desc").map((row) => row.id), ["sample-high", "official", "sample", "missing"]);
});

test("achievement rarity sort uses category order and percentage only as a tie-break", () => {
  const rows = [
    { ...achievement("common-high", 1, "Common high", "common"), percentage: 50 },
    { ...achievement("legendary", 2, "Legendary", "legendary"), percentage: 1 },
    { ...achievement("common-low", 3, "Common low", "common"), percentage: 2 },
    { ...achievement("uncommon", 4, "Uncommon", "uncommon"), percentage: 10 },
    { ...achievement("rare", 5, "Rare", "rare"), percentage: 20 },
    { ...achievement("epic", 6, "Epic", "epic"), percentage: 30 },
    { ...achievement("seasonal", 7, "Seasonal", "seasonal"), percentage: 40 },
    { ...achievement("missing", 8, "Missing", ""), percentage: null, officialPercentage: null },
  ];
  assert.deepEqual(sortProfileAchievements(rows, "rarity", "asc").map((row) => row.id), [
    "common-low", "common-high", "uncommon", "rare", "epic", "legendary", "seasonal", "missing",
  ]);
  assert.deepEqual(sortProfileAchievements(rows, "rarity", "desc").map((row) => row.id), [
    "seasonal", "legendary", "epic", "rare", "uncommon", "common-high", "common-low", "missing",
  ]);
});

test("sample and BSG values remain distinct when sample data is missing", () => {
  const row = { ...achievement("id", 1, "Name"), officialPercentage: 42, officialCategory: "rare" };
  assert.equal(row.percentage, null);
  assert.equal(row.officialPercentage, 42);
  assert.equal(row.officialCategory, "rare");
});

test("achievement description follows the interface locale and falls back to the other language", () => {
  const row = { ...achievement("id", 1, "Name"), description: "English", descriptionRu: "Русский" };
  assert.equal(localizedAchievementDescription(row, "en"), "English");
  assert.equal(localizedAchievementDescription(row, "ru"), "Русский");
  assert.equal(localizedAchievementDescription({ ...row, description: "" }, "en"), "Русский");
});

test("rarest achievements lead with the rarest category and the smallest share", () => {
  const rows = [
    { ...achievement("common-high", 1, "Common high", "common"), percentage: 60 },
    { ...achievement("legendary", 2, "Legendary", "legendary"), percentage: 40 },
    { ...achievement("common-low", 3, "Common low", "common"), percentage: 1 },
    { ...achievement("rare-bsg", 4, "Rare BSG", "rare"), officialPercentage: 3 },
    { ...achievement("rare-sample", 5, "Rare sample", "rare"), percentage: 7 },
    { ...achievement("seasonal", 6, "Seasonal", "seasonal"), percentage: 90 },
  ];
  assert.deepEqual(rarestAchievements(rows, 3).map((row) => row.id), [
    "seasonal", "legendary", "rare-bsg",
  ]);
  assert.deepEqual(rarestAchievements(rows, rows.length).map((row) => row.id), [
    "seasonal", "legendary", "rare-bsg", "rare-sample", "common-low", "common-high",
  ]);
});

test("rarest achievements keep unknown categories and missing shares behind known ones", () => {
  const rows = [
    { ...achievement("unknown-category", 1, "Unknown category", "mythic"), percentage: 0.1 },
    { ...achievement("no-category", 2, "No category", ""), percentage: 0.2 },
    { ...achievement("common-no-share", 3, "Common no share", "common") },
    { ...achievement("common-share", 4, "Common share", "common"), percentage: 50 },
  ];
  assert.deepEqual(rarestAchievements(rows, rows.length).map((row) => row.id), [
    "common-share", "common-no-share", "unknown-category", "no-category",
  ]);
});

test("rarest achievements cap the list and leave the source array alone", () => {
  const rows = [
    { ...achievement("b", 1, "B", "rare") },
    { ...achievement("a", 2, "A", "legendary") },
  ];
  const snapshot = [...rows];
  assert.deepEqual(rarestAchievements(rows, 1).map((row) => row.id), ["a"]);
  assert.deepEqual(rarestAchievements(rows, 9).map((row) => row.id), ["a", "b"]);
  assert.deepEqual(rarestAchievements([], 5), []);
  assert.deepEqual(rarestAchievements(rows, 0), []);
  assert.deepEqual(rarestAchievements(rows, Number.NaN), []);
  // The caller renders component state: sorting in place would reorder it there.
  assert.deepEqual(rows, snapshot);
});

test("achievements of equal scarcity keep a stable id order", () => {
  const left = { ...achievement("aaa", 1, "A", "rare"), percentage: 5 };
  const right = { ...achievement("bbb", 2, "B", "rare"), percentage: 5 };
  assert.ok(compareAchievementScarcity(left, right) < 0);
  assert.ok(compareAchievementScarcity(right, left) > 0);
  assert.equal(compareAchievementScarcity(left, { ...left }), 0);
});
