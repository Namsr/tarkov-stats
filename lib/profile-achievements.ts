export type AchievementSortKey = "date" | "hours" | "alphabet" | "percent" | "rarity";
export type AchievementSortDirection = "asc" | "desc";

export interface ProfileAchievementItem {
  id: string;
  unlockedAt: number | null;
  earlyHours: number | null;
  unlockHours: number | null;
  name: string | null;
  nameRu: string | null;
  description: string | null;
  descriptionRu: string | null;
  imageUrl: string | null;
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

export function localizedAchievementDescription(
  achievement: Pick<ProfileAchievementItem, "description" | "descriptionRu">,
  lang: "en" | "ru",
): string | null {
  const value = lang === "ru" ? achievement.descriptionRu : achievement.description;
  if (value?.trim()) return value;
  if (achievement.description?.trim()) return achievement.description;
  if (achievement.descriptionRu?.trim()) return achievement.descriptionRu;
  return null;
}

// Sort from the least to the most difficult category. Unknown categories
// remain sortable after the complete supported set.
const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "seasonal"];

const RARITY_ALIASES: Record<string, string> = {
  seasonal: "seasonal",
  season: "seasonal",
  event: "seasonal",
  legendary: "legendary",
  "легендарное": "legendary",
  "легендарная": "legendary",
  "легендарный": "legendary",
  epic: "epic",
  "эпическое": "epic",
  "эпическая": "epic",
  "эпический": "epic",
  rare: "rare",
  "редкое": "rare",
  "редкая": "rare",
  "редкий": "rare",
  uncommon: "uncommon",
  "необычное": "uncommon",
  "необычная": "uncommon",
  "необычный": "uncommon",
  common: "common",
  "обычное": "common",
  "обычная": "common",
  "обычный": "common",
};

export function achievementRarityKey(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return RARITY_ALIASES[normalized] ?? (normalized.replace(/[^a-z0-9_-]/g, "") || null);
}

function rarityRank(value: string | null): number | null {
  const key = achievementRarityKey(value);
  if (!key) return null;
  const rank = RARITY_ORDER.indexOf(key);
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
    } else if (key === "hours") {
      result = compareNullable(left.unlockHours, right.unlockHours, (a, b) => a - b, direction);
    } else if (key === "percent") {
      const leftPercentage = left.percentage ?? left.officialPercentage;
      const rightPercentage = right.percentage ?? right.officialPercentage;
      result = compareNullable(leftPercentage, rightPercentage, (a, b) => a - b, direction);
    } else if (key === "rarity") {
      result = compareNullable(
        rarityRank(left.rarity ?? left.officialCategory),
        rarityRank(right.rarity ?? right.officialCategory),
        (a, b) => a - b,
        direction,
      );
      if (result === 0) {
        const leftPercentage = left.percentage ?? left.officialPercentage;
        const rightPercentage = right.percentage ?? right.officialPercentage;
        result = compareNullable(leftPercentage, rightPercentage, (a, b) => a - b, direction);
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
