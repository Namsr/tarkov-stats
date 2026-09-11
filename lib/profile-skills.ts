// Public skill identifiers from the Tarkov JSON reference. Bot-only counters are excluded.
export const PROFILE_SKILL_IDS = [
  "AimDrills",
  "Assault",
  "AttachedLauncher",
  "Attention",
  "Auctions",
  "BearAksystems",
  "BearAssaultoperations",
  "BearAuthority",
  "BearHeavycaliber",
  "BearRawpower",
  "Charisma",
  "Cleanoperations",
  "CovertMovement",
  "Crafting",
  "DMR",
  "Endurance",
  "FieldMedicine",
  "FirstAid",
  "HMG",
  "Health",
  "HeavyVests",
  "HideoutManagement",
  "Immunity",
  "Intellect",
  "LMG",
  "Launcher",
  "LightVests",
  "Lockpicking",
  "MagDrills",
  "Melee",
  "Metabolism",
  "NightOps",
  "Perception",
  "Pistol",
  "Revolver",
  "SMG",
  "Search",
  "Shadowconnections",
  "Shotgun",
  "SilentOps",
  "Sniper",
  "Strength",
  "StressResistance",
  "Surgery",
  "Taskperformance",
  "Throwing",
  "TroubleShooting",
  "Vitality",
  "WeaponTreatment"
] as const;

export interface ProfileSkill { id: string; progress: number; level: number; percent: number; elite: boolean }

export function normalizeProfileSkill(value: unknown): ProfileSkill | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = row.Id ?? row.id;
  const raw = row.Progress ?? row.progress;
  if (typeof id !== "string" || !(PROFILE_SKILL_IDS as readonly string[]).includes(id) || (typeof raw !== "number" && typeof raw !== "string")) return null;
  const progress = Number(raw);
  if (!Number.isFinite(progress) || progress <= 0) return null;
  const level = Math.min(51, Math.floor(progress / 100));
  return { id, progress, level, elite: level === 51, percent: level === 51 ? 100 : progress - level * 100 };
}
