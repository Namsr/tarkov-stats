import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner resolves the explicit .ts module.
import { localizedAchievementName, sortProfileAchievements, type ProfileAchievementItem } from "../lib/profile-achievements.ts";

const achievement = (id: string, unlockedAt: number | null, name: string, rarity = "common"): ProfileAchievementItem => ({
  id,
  unlockedAt,
  name,
  nameRu: null,
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

test("achievement rarity sort keeps unknown values before missing values", () => {
  const rows = [
    { ...achievement("missing", 1, "Missing", ""), officialPercentage: null },
    { ...achievement("official", 2, "Official", "common"), officialPercentage: 10 },
    { ...achievement("sample", 3, "Sample", "common"), percentage: 2, officialPercentage: 90 },
    { ...achievement("legendary", 4, "Legendary", "legendary"), officialPercentage: null },
  ];
  assert.deepEqual(sortProfileAchievements(rows, "rarity", "asc").map((row) => row.id), ["sample", "official", "legendary", "missing"]);
  assert.deepEqual(sortProfileAchievements(rows, "rarity", "desc").map((row) => row.id), ["official", "sample", "legendary", "missing"]);
});

test("sample and BSG values remain distinct when sample data is missing", () => {
  const row = { ...achievement("id", 1, "Name"), officialPercentage: 42, officialCategory: "rare" };
  assert.equal(row.percentage, null);
  assert.equal(row.officialPercentage, 42);
  assert.equal(row.officialCategory, "rare");
});
