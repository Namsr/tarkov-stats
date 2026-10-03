import { ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE } from "../achievement-unlock-hours.ts";
import { parseSeasonalAchievementUnlocks } from "./storage.ts";
import type { SeasonalAchievementBaseline } from "./average-db.ts";

type Contribution = { hours: number | null; day: number | null };
type Sample = { sorted: number[]; mean: number; squaredDeviations: number };

function sample(values: number[]): Sample {
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    sorted: values.sort((left, right) => left - right),
    mean,
    squaredDeviations: values.reduce((sum, value) => sum + (value - mean) ** 2, 0),
  };
}

// Removing one owner's contribution changes at most one order statistic.
// Locate it once instead of copying/sorting the population for each player.
function withoutOwner(input: Sample, removed: number | null) {
  const values = input.sorted;
  let removedIndex = values.length;
  if (removed !== null) {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[mid] < removed) lo = mid + 1;
      else hi = mid;
    }
    removedIndex = lo;
  }
  const n = values.length - (removed === null ? 0 : 1);
  const at = (index: number): number | null => n > 0
    ? values[index + (removedIndex <= index ? 1 : 0)] ?? null
    : null;
  const mean = n === 0 ? 0 : removed === null ? input.mean
    : (input.mean * values.length - removed) / n;
  const squaredDeviations = removed === null ? input.squaredDeviations
    : input.squaredDeviations - (removed - input.mean) * (removed - mean);
  return {
    n,
    mean,
    std: n ? Math.sqrt(Math.max(0, squaredDeviations / n)) : 0,
    early: at(Math.floor((n - 1) * 0.2)),
    unlock: at(Math.max(0, Math.ceil(n / (n >= ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE ? 100 : 20)) - 1)),
  };
}

export function prepareSeasonalRiskAchievements(
  rows: readonly Record<string, unknown>[],
  seasonStartsAt: number | null,
): (excludeAid?: number) => SeasonalAchievementBaseline {
  const eligible = new Set<number>();
  const groups = new Map<string, Map<number, Contribution>>();
  for (const row of rows) {
    const achievements = parseSeasonalAchievementUnlocks(row.achievements);
    if (achievements === null) continue;
    const aid = Number(row.aid);
    eligible.add(aid);
    const hours = Number.isFinite(Number(row.hours)) ? Number(row.hours) : null;
    const startsAt = Number.isFinite(Number(row.starts_at)) ? Number(row.starts_at) : null;
    for (const achievement of achievements) {
      const owners = groups.get(achievement.id) ?? new Map<number, Contribution>();
      const day = achievement.unlockedAt !== null && startsAt !== null
        ? (achievement.unlockedAt - startsAt) / 86_400_000 : null;
      owners.set(aid, {
        hours: hours !== null && hours >= 0 ? hours : null,
        day: day !== null && Number.isFinite(day) && day >= 0 ? day : null,
      });
      groups.set(achievement.id, owners);
    }
  }
  const prepared = [...groups].map(([id, owners]) => {
    const contributions = [...owners.values()];
    return {
      id, owners,
      hours: sample(contributions.flatMap((entry) => entry.hours === null ? [] : [entry.hours])),
      days: sample(contributions.flatMap((entry) => entry.day === null ? [] : [entry.day])),
    };
  });
  return (excludeAid) => {
    const eligibleN = eligible.size - (excludeAid !== undefined && eligible.has(excludeAid) ? 1 : 0);
    return {
      total: eligibleN, eligibleN, seasonStartsAt,
      achievements: prepared.flatMap((entry) => {
        const excluded = excludeAid === undefined ? undefined : entry.owners.get(excludeAid);
        const owners = entry.owners.size - (excluded ? 1 : 0);
        if (!owners) return [];
        const hours = withoutOwner(entry.hours, excluded?.hours ?? null);
        const days = withoutOwner(entry.days, excluded?.day ?? null);
        return [{
          ach_id: entry.id, owners, eligibleN,
          prevalencePct: eligibleN > 0 ? owners / eligibleN * 100 : 0,
          meanHours: hours.mean, stdHours: hours.std, earlyHours: hours.early ?? hours.mean,
          unlockHours: hours.unlock ?? hours.mean,
          unlockDayP20: days.early, timestampOwners: days.n,
        }];
      }).sort((left, right) => left.prevalencePct - right.prevalencePct || left.ach_id.localeCompare(right.ach_id)),
    };
  };
}
