import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner resolves the explicit .ts module.
import {
  localizedAchievementDescription,
  localizedAchievementName,
  sortProfileAchievements,
  type ProfileAchievementItem,
} from "../lib/profile-achievements.ts";

const achievement = (id: string, unlockedAt: number | null, name: string, rarity = "common"): ProfileAchievementItem => ({
  id,
  unlockedAt,
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
