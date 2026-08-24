import type { WeaponMasteryProgress } from "@/types/tarkov";

export interface WeaponMasteryReference {
  id: string;
  weapons: string[];
  level2: number;
  level3: number;
}

export interface ProfileWeaponMastery extends WeaponMasteryProgress {
  weapon: string;
  level: 1 | 2 | 3;
}

/** Matches the whole-number value shown by the mastery table. */
export function displayedWeaponMasteryProgress(progress: number): number {
  return Math.round(progress);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Parses the JSON API handbook.mastering reference at the trust boundary. */
export function parseWeaponMastery(payload: unknown): WeaponMasteryReference[] {
  const rows = record(record(payload)?.data)?.mastering;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("items.data.mastering must be a non-empty array");
  }
  const seen = new Set<string>();
  return rows.flatMap((value, index) => {
    const row = record(value);
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const weapons = Array.isArray(row?.weapons)
      ? row.weapons.filter((weapon): weapon is string => typeof weapon === "string" && weapon.trim() !== "").map((weapon) => weapon.trim())
      : [];
    const level2 = finiteNumber(row?.level2);
    const level3 = finiteNumber(row?.level3);
    if (!id || seen.has(id) || weapons.length === 0 || level2 == null || level3 == null ||
      level2 < 0 || level3 < level2) {
      throw new Error(`items.data.mastering[${index}] is invalid`);
    }
    seen.add(id);
    return [{ id, weapons, level2, level3 }];
  });
}

/** Converts a profile Mastering progress value to Tarkov's 1/2/3 level. */
export function weaponMasteryLevel(
  progress: number,
  reference: Pick<WeaponMasteryReference, "level2" | "level3">,
): 1 | 2 | 3 {
  if (progress >= reference.level3) return 3;
  if (progress >= reference.level2) return 2;
  return 1;
}

/** Keeps only finite, non-negative profile.skills.Mastering rows. */
export function normalizeWeaponMastery(value: unknown): WeaponMasteryProgress[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const row = record(entry);
    const id = typeof row?.Id === "string"
      ? row.Id.trim()
      : typeof row?.id === "string" ? row.id.trim() : "";
    const progress = finiteNumber(row?.Progress ?? row?.progress);
    if (!id || seen.has(id) || progress == null || progress < 0) return [];
    seen.add(id);
    return [{ id, progress }];
  });
}

/** Joins stored progress to handbook names and level thresholds. */
export function buildWeaponMasteryRows(
  progressRows: readonly WeaponMasteryProgress[] | null | undefined,
  references: readonly WeaponMasteryReference[],
): ProfileWeaponMastery[] {
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const byLowerId = new Map(references.map((reference) => [reference.id.toLowerCase(), reference]));
  return (progressRows ?? []).flatMap((row) => {
    const reference = byId.get(row.id) ?? byLowerId.get(row.id.toLowerCase());
    if (!reference || !Number.isFinite(row.progress) || row.progress < 0) return [];
    return [{
      id: row.id,
      progress: row.progress,
      weapon: reference.id,
      level: weaponMasteryLevel(row.progress, reference),
    }];
  });
}

export type WeaponMasterySortKey = "weapon" | "progress";
export type WeaponMasterySortDirection = "asc" | "desc";

export function sortWeaponMastery(
  rows: readonly ProfileWeaponMastery[],
  key: WeaponMasterySortKey = "progress",
  direction: WeaponMasterySortDirection = "desc",
  locale?: string,
): ProfileWeaponMastery[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const comparison = key === "weapon"
      ? a.weapon.localeCompare(b.weapon, locale)
      : (a.level - b.level) || (a.progress - b.progress);
    if (comparison !== 0) return comparison * multiplier;
    return a.id.localeCompare(b.id);
  });
}
