export type AchievementSortKey = "date" | "alphabet" | "rarity";
export type AchievementSortDirection = "asc" | "desc";

export interface ProfileAchievementItem {
  id: string;
  unlockedAt: number | null;
  name: string | null;
  nameRu: string | null;
  rarity: string | null;
  owners: number | null;
  eligibleN: number | null;
  percentage: number | null;
  officialPercentage: number | null;
  officialCategory: string | null;
}

export function localizedAchievementName(
  achievement: Pick<ProfileAchievementItem, "id" | "name" | "nameRu">,
  lang: "en" | "ru",
): string {
  return (lang === "ru" ? achievement.nameRu : achievement.name)
    ?? achievement.name
    ?? achievement.nameRu
    ?? achievement.id;
}

const RARITY_ORDER = ["seasonal", "legendary", "epic", "rare", "uncommon", "common"];

function rarityRank(value: string | null): number | null {
  if (!value) return null;
  const rank = RARITY_ORDER.indexOf(value.toLowerCase());
  return rank < 0 ? RARITY_ORDER.length : rank;
}

function compareNullable<T>(
  left: T | null,
  right: T | null,
  compare: (a: T, b: T) => number,
  direction: AchievementSortDirection,
): number {
  if (left == null && right == null) return 0;
  // Missing values stay at the end in either direction.
  if (left == null) return 1;
  if (right == null) return -1;
  return compare(left, right) * (direction === "asc" ? 1 : -1);
}

export function sortProfileAchievements(
  achievements: readonly ProfileAchievementItem[],
  key: AchievementSortKey = "date",
  direction: AchievementSortDirection = "desc",
  locale = "en",
): ProfileAchievementItem[] {
  return [...achievements].sort((left, right) => {
    let result = 0;
    if (key === "date") {
      result = compareNullable(left.unlockedAt, right.unlockedAt, (a, b) => a - b, direction);
    } else if (key === "rarity") {
      const leftPercentage = left.percentage ?? left.officialPercentage;
      const rightPercentage = right.percentage ?? right.officialPercentage;
      result = compareNullable(leftPercentage, rightPercentage, (a, b) => a - b, direction);
      if (result === 0 && leftPercentage == null && rightPercentage == null) {
        result = compareNullable(
          rarityRank(left.officialCategory ?? left.rarity),
          rarityRank(right.officialCategory ?? right.rarity),
          (a, b) => a - b,
          direction,
        );
      }
    } else {
      result = compareNullable(
        localizedAchievementName(left, locale === "ru" ? "ru" : "en"),
        localizedAchievementName(right, locale === "ru" ? "ru" : "en"),
        (a, b) => a.localeCompare(b, locale, { sensitivity: "base" }),
        direction,
      );
    }
    if (result !== 0) return result;
    return left.id.localeCompare(right.id, locale, { sensitivity: "base" });
  });
}
