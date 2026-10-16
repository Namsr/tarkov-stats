import assert from "node:assert/strict";
import test from "node:test";
import { achievementUnlockHours } from "../lib/achievement-unlock-hours.ts";
import { percentile20 } from "../lib/seasonal/analytics.ts";
import { prepareSeasonalRiskAchievements } from "../lib/seasonal/risk-achievement-population.ts";
import { parseSeasonalAchievementUnlocks } from "../lib/seasonal/storage.ts";

// Reference retains the previous per-player filtering and full sort, so cached
// removal is checked against the calculation it replaces.
function reference(rows: Record<string, unknown>[], excludeAid?: number) {
  const eligible = rows.filter((row) => row.aid !== excludeAid).flatMap((row) => {
    const achievements = parseSeasonalAchievementUnlocks(row.achievements);
    return achievements === null ? [] : [{ aid: Number(row.aid), hours: row.hours, starts_at: row.starts_at, achievements }];
  });
  const groups = new Map<string, { hours: number[]; days: number[]; owners: Set<number> }>();
  for (const row of eligible) {
    for (const achievement of row.achievements) {
      const group = groups.get(achievement.id) ?? { hours: [], days: [], owners: new Set<number>() };
      group.owners.add(Number(row.aid));
      const hours = Number(row.hours);
      if (Number.isFinite(hours) && hours >= 0) group.hours.push(hours);
      const day = achievement.unlockedAt === null ? NaN : (achievement.unlockedAt - Number(row.starts_at)) / 86_400_000;
      if (Number.isFinite(day) && day >= 0) group.days.push(day);
      groups.set(achievement.id, group);
    }
  }
  return {
    total: eligible.length, eligibleN: eligible.length, seasonStartsAt: 0,
    achievements: [...groups].map(([ach_id, group]) => {
      const meanHours = group.hours.length ? group.hours.reduce((sum, hours) => sum + hours, 0) / group.hours.length : 0;
      const variance = group.hours.length ? group.hours.reduce((sum, hours) => sum + (hours - meanHours) ** 2, 0) / group.hours.length : 0;
      return {
        ach_id, owners: group.owners.size, eligibleN: eligible.length,
        prevalencePct: eligible.length ? group.owners.size / eligible.length * 100 : 0,
        meanHours, stdHours: Math.sqrt(variance), earlyHours: percentile20(group.hours) ?? meanHours,
        unlockHours: achievementUnlockHours(group.hours) ?? meanHours,
        unlockDayP20: percentile20(group.days), timestampOwners: group.days.length,
      };
    }).sort((left, right) => left.prevalencePct - right.prevalencePct || left.ach_id.localeCompare(right.ach_id)),
  };
}

function compare(rows: Record<string, unknown>[], excluded: (number | undefined)[]) {
  const prepared = prepareSeasonalRiskAchievements(rows, 0);
  for (const aid of excluded) {
    const actual = prepared(aid);
    const expected = reference(rows, aid);
    assert.equal(actual.total, expected.total);
    assert.equal(actual.seasonStartsAt, expected.seasonStartsAt);
    assert.equal(actual.achievements.length, expected.achievements.length);
    actual.achievements.forEach((achievement, index) => {
      const { meanHours, stdHours, ...exact } = achievement;
      const { meanHours: expectedMean, stdHours: expectedStd, ...expectedExact } = expected.achievements[index];
      assert.deepEqual(exact, expectedExact, `aid=${aid}`);
      assert.ok(Math.abs(meanHours - expectedMean) <= 1e-9 * Math.max(1, expectedMean));
      assert.ok(Math.abs(stdHours - expectedStd) <= 1e-9 * Math.max(1, expectedStd));
    });
  }
}

test("prepared population preserves self exclusion, missing/duplicate data and empty-owner denominator", () => {
  compare([
    { aid: 1, hours: 10, starts_at: 0, achievements: '[{"id":"a","unlockedAt":86400000},{"id":"a","unlockedAt":86400000},{"id":"solo","unlockedAt":null}]' },
    { aid: 2, hours: 10, starts_at: 0, achievements: '["a","legacy"]' },
    { aid: 3, hours: null, starts_at: 0, achievements: '[{"id":"a","unlockedAt":172800000}]' },
    { aid: 4, hours: -1, starts_at: 0, achievements: '[{"id":"a","unlockedAt":-86400000}]' },
    { aid: 5, hours: NaN, starts_at: 0, achievements: '[]' },
    { aid: 6, hours: 20, starts_at: null, achievements: '[{"id":"a","unlockedAt":0}]' },
    { aid: 7, hours: 30, starts_at: 0, achievements: '{"invalid":true}' },
    { aid: 8, hours: 30, starts_at: 0, achievements: 'invalid' },
  ], [undefined, 1, 2, 3, 4, 5, 6, 7, 999]);
  compare([], [undefined, 1]);
});

test("excluding a player keeps percentiles exact across the 500-owner threshold", () => {
  for (const count of [1, 2, 30, 499, 500, 501]) {
    const rows = Array.from({ length: count }, (_, index) => ({
      aid: index + 1, hours: (index * 137 % count) / 3, starts_at: 0,
      achievements: JSON.stringify([{ id: "a", unlockedAt: (index * 7 % count) * 86_400_000 }]),
    }));
    compare(rows, [undefined, 1, Math.ceil(count / 2), count, count + 1]);
  }
});
