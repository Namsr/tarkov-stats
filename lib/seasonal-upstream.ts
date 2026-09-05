import type {
  CycleId,
  SeasonalCounters,
  SeasonalStats,
  SeasonalProfile,
  SeasonalAchievementUnlock,
  SeasonalCommonSkill,
  SeasonalUpstreamContract as SeasonalUpstreamContractType,
} from "@/types/seasonal";
import type { WeaponMasteryProgress } from "@/types/tarkov";
// Relative import keeps this parser usable by the strip-types test runner and
// by the Next server bundle without relying on tsconfig path aliases. The
// explicit extension is required by Node's strip-types ESM loader; Next's
// bundler supports it, while TypeScript's bundler resolver reports a false
// positive for this cross-runtime import.
// @ts-expect-error Node strip-types requires the explicit .ts extension here.
import { expToLevel, PLAYER_LEVELS_V2026_07_22 } from "./tarkov-api.ts";
// @ts-expect-error Node strip-types requires the explicit .ts extension here.
import { normalizeWeaponMastery } from "./profile-mastery.ts";

export type SeasonalUpstreamContract = SeasonalUpstreamContractType;

export interface SeasonalAdapterOptions {
  /** Seasonal remains fail-closed until rollout explicitly enables it. */
  enabled: boolean;
  /** The contract confirmed by a real upstream JSON fixture. */
  confirmedContract: SeasonalUpstreamContract | null;
  cycleId: CycleId;
  seasonStartsAt: number;
  seasonEndsAt?: number | null;
  /** Optional separately linked value; omitted values fall back to upstream account time. */
  lifetimePvpHours?: number | null;
}

export type SeasonalValidationCode =
  | "feature_disabled"
  | "contract_unconfirmed"
  | "contract_mismatch"
  | "invalid_payload"
  | "cycle_mismatch"
  | "outside_season"
  | "no_completed_raids";

export class SeasonalValidationError extends Error {
  readonly code: SeasonalValidationCode;

  constructor(code: SeasonalValidationCode, message: string) {
    super(message);
    this.name = "SeasonalValidationError";
    this.code = code;
  }
}

export type SeasonalValidationResult =
  | { ok: true; profile: SeasonalProfile }
  | { ok: false; code: SeasonalValidationCode; message: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new SeasonalValidationError("invalid_payload", `${field} must be an object`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeasonalValidationError("invalid_payload", `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function finiteNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) {
    throw new SeasonalValidationError("invalid_payload", `${field} must be a finite number`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new SeasonalValidationError(
      "invalid_payload",
      `${field} must be a non-negative safe integer`
    );
  }
  return number;
}

function positiveAid(value: unknown): number {
  const aid = nonNegativeInteger(value, "aid");
  if (aid === 0) {
    throw new SeasonalValidationError("invalid_payload", "aid must be a positive safe integer");
  }
  return aid;
}

/** Upstream activity fields use Unix seconds while profile.updated uses Unix ms. */
function unixMilliseconds(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (number < 1_000_000_000 || number >= 10_000_000_000_000) {
    throw new SeasonalValidationError("invalid_payload", `${field} is not a Unix timestamp`);
  }
  return Math.trunc(number < 10_000_000_000 ? number * 1_000 : number);
}

interface ExtractedContract {
  aid: number;
  cycleId: string;
  profile: UnknownRecord;
}

function extractGameModeContract(payload: UnknownRecord): ExtractedContract {
  if (payload.gameMode !== "seasonal") {
    throw new SeasonalValidationError(
      "contract_mismatch",
      "Expected the confirmed seasonal gameMode contract"
    );
  }
  return {
    aid: positiveAid(payload.aid),
    cycleId: requiredString(payload.cycleId, "cycleId"),
    profile: requiredRecord(payload.profile, "profile"),
  };
}

function extractProfileSectionContract(payload: UnknownRecord): ExtractedContract {
  if (!isRecord(payload.seasonal)) {
    throw new SeasonalValidationError(
      "contract_mismatch",
      "Expected the confirmed Seasonal profile section contract"
    );
  }
  const seasonal = requiredRecord(payload.seasonal, "seasonal");
  return {
    aid: positiveAid(payload.aid),
    cycleId: requiredString(seasonal.cycleId, "seasonal.cycleId"),
    profile: requiredRecord(seasonal.profile, "seasonal.profile"),
  };
}

/**
 * The public static cache may expose the ordinary profile object directly.
 * The cycle is supplied by our confirmed configuration because direct
 * profiles do not carry a Seasonal wrapper or cycle id.
 */
function extractDirectProfileContract(
  payload: UnknownRecord,
  cycleId: string,
): ExtractedContract {
  const profile = requiredRecord(payload, "profile");
  const aid = payload.aid ?? profile.aid;
  return {
    aid: positiveAid(aid),
    cycleId,
    profile,
  };
}

function counterItems(stats: unknown, field: string): UnknownRecord[] {
  const root = requiredRecord(stats, field);
  const eft = requiredRecord(root.eft, `${field}.eft`);
  const counters = requiredRecord(eft.overAllCounters, `${field}.eft.overAllCounters`);
  if (!Array.isArray(counters.Items)) {
    throw new SeasonalValidationError(
      "invalid_payload",
      `${field}.eft.overAllCounters.Items must be an array`
    );
  }
  return counters.Items.map((item, index) =>
    requiredRecord(item, `${field}.eft.overAllCounters.Items[${index}]`)
  );
}

/**
 * The confirmed pvp-season JSON also carries account-wide playtime in seconds.
 * Use it as a fallback when the separately linked regular-PvP profile has not
 * been captured yet; an explicitly supplied linked value still takes priority.
 */
function totalInGameTimeHours(profile: UnknownRecord): number | null {
  for (const field of ["pmcStats", "scavStats"] as const) {
    const stats = requiredRecord(profile[field], `profile.${field}`);
    const eft = requiredRecord(stats.eft, `profile.${field}.eft`);
    if (eft.totalInGameTime === undefined || eft.totalInGameTime === null) continue;
    const seconds = finiteNumber(eft.totalInGameTime, `profile.${field}.eft.totalInGameTime`);
    if (seconds < 0) {
      throw new SeasonalValidationError(
        "invalid_payload",
        `profile.${field}.eft.totalInGameTime must be non-negative`
      );
    }
    return Math.round((seconds / 3600) * 10) / 10;
  }
  return null;
}

function counterValue(items: UnknownRecord[], ...keys: string[]): number {
  const item = items.find(
    (candidate) =>
      Array.isArray(candidate.Key) &&
      candidate.Key.length === keys.length &&
      candidate.Key.every((key, index) => key === keys[index])
  );
  if (!item) return 0;
  return nonNegativeInteger(item.Value, `counter ${keys.join("/")}`);
}

/** Derived portrait counters stay NULL when the upstream omits that counter. */
function optionalCounterValue(items: UnknownRecord[], ...keys: string[]): number | null {
  const item = items.find(
    (candidate) =>
      Array.isArray(candidate.Key) &&
      candidate.Key.length === keys.length &&
      candidate.Key.every((key, index) => key === keys[index])
  );
  return item ? nonNegativeInteger(item.Value, `counter ${keys.join("/")}`) : null;
}

function parseCounters(profile: UnknownRecord): { counters: SeasonalCounters; pvpStatsVersion: number } {
  const info = requiredRecord(profile.info, "profile.info");
  const pmc = counterItems(profile.pmcStats, "profile.pmcStats");
  const scav = counterItems(profile.scavStats, "profile.scavStats");

  const exactPmcRaids = optionalCounterValue(pmc, "Sessions", "Pmc");
  const exactPmcDeaths = optionalCounterValue(pmc, "Deaths");
  const exactPmcKilledPmc = optionalCounterValue(pmc, "KilledPmc");
  const counters: SeasonalCounters = {
    experience: nonNegativeInteger(info.experience, "profile.info.experience"),
    pmcRaids: exactPmcRaids ?? 0,
    scavRaids: counterValue(scav, "Sessions", "Scav"),
    pmcSurvived: counterValue(pmc, "ExitStatus", "Survived", "Pmc"),
    pmcDeaths: exactPmcDeaths ?? 0,
    pmcKills: counterValue(pmc, "Kills"),
    killedPmc: exactPmcKilledPmc ?? 0,
  };
  Object.defineProperty(counters, "pmcKilledPmc", { value: exactPmcKilledPmc, enumerable: false });
  return {
    counters,
    pvpStatsVersion: exactPmcRaids !== null && exactPmcDeaths !== null && exactPmcKilledPmc !== null ? 1 : 0,
  };
}

/** Latest skill activity that proves positive progress, excluding achievement/profile fallbacks. */
export function seasonalLeaderboardActivity(profile: unknown): number | null {
  const root = requiredRecord(profile, "profile");
  if (root.skills === undefined) return null;
  const skills = requiredRecord(root.skills, "profile.skills");
  if (!Array.isArray(skills.Common)) {
    throw new SeasonalValidationError("invalid_payload", "profile.skills.Common must be an array");
  }
  const candidates: number[] = [];
  skills.Common.forEach((value, index) => {
    const skill = requiredRecord(value, `profile.skills.Common[${index}]`);
    if (skill.Progress === undefined || skill.Progress === null ||
        skill.LastAccess === undefined || skill.LastAccess === null) return;
    const progress = finiteNumber(skill.Progress, `profile.skills.Common[${index}].Progress`);
    const lastAccess = finiteNumber(skill.LastAccess, `profile.skills.Common[${index}].LastAccess`);
    if (progress > 0 && lastAccess > 0) {
      candidates.push(unixMilliseconds(lastAccess, `profile.skills.Common[${index}].LastAccess`));
    }
  });
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Reads the Seasonal profile's own achievement payload once at the trust
 * boundary. Missing `achievements` is different from an empty object or empty
 * array: the former is an unknown payload and must be excluded from prevalence
 * denominators, while the latter are known players with no achievements.
 */
function parseSeasonalAchievements(profile: UnknownRecord): SeasonalAchievementUnlock[] | null {
  if (profile.achievements === undefined) return null;
  if (Array.isArray(profile.achievements)) {
    if (profile.achievements.length === 0) return [];
    throw new SeasonalValidationError("invalid_payload", "profile.achievements must be an object");
  }
  const achievements = requiredRecord(profile.achievements, "profile.achievements");
  return Object.entries(achievements)
    .map(([id, timestamp]) => ({
      id,
      unlockedAt: unixMilliseconds(timestamp, `profile.achievements.${id}`),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Keep the latest Common-skills payload for the profile view.  The parser only
 * validates the array/object boundary here; individual skill fields are kept
 * open because EFT adds and removes fields between wipes.
 */
function parseSeasonalCommonSkills(profile: UnknownRecord): SeasonalCommonSkill[] | null {
  if (profile.skills === undefined) return null;
  const skills = requiredRecord(profile.skills, "profile.skills");
  if (!Array.isArray(skills.Common)) {
    throw new SeasonalValidationError("invalid_payload", "profile.skills.Common must be an array");
  }
  return skills.Common.map((value, index) => ({
    ...requiredRecord(value, `profile.skills.Common[${index}]`),
  }));
}

/** Keep normalized Mastering rows while allowing older seasonal payloads to omit them. */
function parseSeasonalWeaponMastery(profile: UnknownRecord): WeaponMasteryProgress[] | null {
  if (profile.skills === undefined) return null;
  const skills = requiredRecord(profile.skills, "profile.skills");
  if (skills.Mastering === undefined) return null;
  if (!Array.isArray(skills.Mastering)) {
    throw new SeasonalValidationError("invalid_payload", "profile.skills.Mastering must be an array");
  }
  return normalizeWeaponMastery(skills.Mastering);
}

function parseSeasonalStats(profile: UnknownRecord, counters: SeasonalCounters): SeasonalStats {
  const info = requiredRecord(profile.info, "profile.info");
  const pmc = counterItems(profile.pmcStats, "profile.pmcStats");
  const scav = counterItems(profile.scavStats, "profile.scavStats");
  const totalRaids = counters.pmcRaids + counters.scavRaids;
  const pmcSurvived = optionalCounterValue(pmc, "ExitStatus", "Survived", "Pmc");
  const scavSurvived = optionalCounterValue(scav, "ExitStatus", "Survived", "Scav");
  const scavKills = optionalCounterValue(scav, "Kills");
  const scavDeaths = optionalCounterValue(scav, "Deaths");
  const pmcKills = optionalCounterValue(pmc, "Kills");
  const pmcDeaths = optionalCounterValue(pmc, "Deaths");
  const killedPmc = optionalCounterValue(pmc, "KilledPmc");
  const totalKills = pmcKills == null || (scavKills == null && counters.scavRaids > 0)
    ? null
    : pmcKills + (scavKills ?? 0);
  const deaths = pmcDeaths == null || (scavDeaths == null && counters.scavRaids > 0)
    ? null
    : pmcDeaths + (scavDeaths ?? 0);
  const survivedRaids = pmcSurvived == null || (scavSurvived == null && counters.scavRaids > 0)
    ? null
    : pmcSurvived + (scavSurvived ?? 0);
  const survivalRate = survivedRaids == null || totalRaids <= 0 ? null : 100 * survivedRaids / totalRaids;
  const kdRatio = totalKills == null || deaths == null ? null : deaths > 0 ? totalKills / deaths : totalKills;
  const pmcKdRatio = killedPmc == null || pmcDeaths == null
    ? null
    : pmcDeaths > 0 ? killedPmc / pmcDeaths : killedPmc;
  const killsPerRaid = totalKills == null || totalRaids <= 0 ? null : totalKills / totalRaids;
  const pmcSurvivalRate = pmcSurvived == null || counters.pmcRaids <= 0
    ? null
    : 100 * pmcSurvived / counters.pmcRaids;
  const pmcRunThrough = optionalCounterValue(pmc, "ExitStatus", "Runner", "Pmc");
  const scavRunThrough = optionalCounterValue(scav, "ExitStatus", "Runner", "Scav");
  const runThrough = pmcRunThrough == null || (scavRunThrough == null && counters.scavRaids > 0)
    ? null
    : pmcRunThrough + (scavRunThrough ?? 0);
  const seasonalAchievements = parseSeasonalAchievements(profile);
  return {
    totalRaids,
    survivedRaids,
    totalKills,
    deaths,
    runThrough,
    survivalRate,
    kdRatio,
    pmcKdRatio,
    killsPerRaid,
    pmcSurvivalRate,
    // Level is derived from the shared Seasonal XP table at the ingestion
    // boundary; it is never copied from the regular PvP profile.
    level: expToLevel(counters.experience, [...PLAYER_LEVELS_V2026_07_22]),
    prestige: info.prestigeLevel === undefined ? null : nonNegativeInteger(info.prestigeLevel, "profile.info.prestigeLevel"),
    longestWinStreak: optionalCounterValue(pmc, "LongestWinStreak", "Pmc"),
    achievementsCount: seasonalAchievements === null ? null : seasonalAchievements.length,
  };
}

function parseStaticSignals(profile: UnknownRecord) {
  const info = requiredRecord(profile.info, "profile.info");
  const pmc = counterItems(profile.pmcStats, "profile.pmcStats");
  const achievements = parseSeasonalAchievements(profile) ?? [];
  return {
    prestige: info.prestigeLevel === undefined
      ? 0
      : nonNegativeInteger(info.prestigeLevel, "profile.info.prestigeLevel"),
    longestWinStreak: counterValue(pmc, "LongestWinStreak", "Pmc"),
    achievementIds: achievements.map((achievement) => achievement.id),
  };
}

function validateCounterRelationships(counters: SeasonalCounters): void {
  if (counters.pmcSurvived > counters.pmcRaids) {
    throw new SeasonalValidationError(
      "invalid_payload",
      "profile PMC survived count cannot exceed PMC raids"
    );
  }
  if (counters.killedPmc > counters.pmcKills) {
    throw new SeasonalValidationError(
      "invalid_payload",
      "profile killed-PMC count cannot exceed all PMC kills"
    );
  }
}

/** Returns the latest activity signal from skills and achievements, in Unix ms. */
export function seasonalLastAccess(profile: unknown): number {
  const root = requiredRecord(profile, "profile");
  const candidates: number[] = [];

  if (root.skills !== undefined) {
    const skills = requiredRecord(root.skills, "profile.skills");
    if (!Array.isArray(skills.Common)) {
      throw new SeasonalValidationError("invalid_payload", "profile.skills.Common must be an array");
    }
    skills.Common.forEach((value, index) => {
      const skill = requiredRecord(value, `profile.skills.Common[${index}]`);
      if (skill.LastAccess !== undefined && skill.LastAccess !== null) {
        const lastAccess = finiteNumber(
          skill.LastAccess,
          `profile.skills.Common[${index}].LastAccess`
        );
        // EFT uses negative sentinels for skills that have never been accessed.
        if (lastAccess > 0) {
          candidates.push(
            unixMilliseconds(lastAccess, `profile.skills.Common[${index}].LastAccess`)
          );
        }
      }
    });
  }

  if (root.achievements !== undefined) {
    if (Array.isArray(root.achievements)) {
      if (root.achievements.length > 0) {
        throw new SeasonalValidationError("invalid_payload", "profile.achievements must be an object");
      }
    } else {
      const achievements = requiredRecord(root.achievements, "profile.achievements");
      Object.entries(achievements).forEach(([id, timestamp]) => {
        candidates.push(unixMilliseconds(timestamp, `profile.achievements.${id}`));
      });
    }
  }

  // Fresh accounts can have no completed raids and no unlocked achievements
  // yet. Their profile.updated timestamp is still a trustworthy current-cycle
  // activity signal, so keep the account visible instead of rejecting it.
  if (candidates.length === 0 && root.updated !== undefined && root.updated !== null) {
    return unixMilliseconds(root.updated, "profile.updated");
  }
  if (candidates.length === 0) {
    throw new SeasonalValidationError(
      "invalid_payload",
      "profile must contain an activity timestamp"
    );
  }
  return Math.max(...candidates);
}

export function isSeasonalUpstreamReady(
  options: Pick<SeasonalAdapterOptions, "enabled" | "confirmedContract">
): boolean {
  return options.enabled && options.confirmedContract !== null;
}

export function parseSeasonalProfile(
  payload: unknown,
  options: SeasonalAdapterOptions
): SeasonalProfile {
  if (!options.enabled) {
    throw new SeasonalValidationError("feature_disabled", "Seasonal upstream is disabled");
  }
  if (options.confirmedContract === null) {
    throw new SeasonalValidationError(
      "contract_unconfirmed",
      "Seasonal upstream contract has not been confirmed by a fixture"
    );
  }

  const root = requiredRecord(payload, "payload");
  const extracted = options.confirmedContract === "game_mode"
    ? extractGameModeContract(root)
    : options.confirmedContract === "profile_section"
      ? extractProfileSectionContract(root)
      : extractDirectProfileContract(root, options.cycleId);

  if (extracted.cycleId !== options.cycleId) {
    throw new SeasonalValidationError(
      "cycle_mismatch",
      `Expected cycle ${options.cycleId}, received ${extracted.cycleId}`
    );
  }

  const { counters, pvpStatsVersion } = parseCounters(extracted.profile);
  const seasonalAchievements = parseSeasonalAchievements(extracted.profile);
  const commonSkills = parseSeasonalCommonSkills(extracted.profile);
  const weaponMastery = parseSeasonalWeaponMastery(extracted.profile);
  const seasonalStats = parseSeasonalStats(extracted.profile, counters);
  validateCounterRelationships(counters);

  const lastAccessAt = seasonalLastAccess(extracted.profile);
  const leaderboardActivityAt = seasonalLeaderboardActivity(extracted.profile);
  const profileUpdatedAt = unixMilliseconds(extracted.profile.updated, "profile.updated");
  const seasonEndsAt = options.seasonEndsAt ?? null;
  if (
    lastAccessAt < options.seasonStartsAt ||
    profileUpdatedAt < options.seasonStartsAt ||
    (seasonEndsAt !== null &&
      (lastAccessAt > seasonEndsAt || profileUpdatedAt > seasonEndsAt))
  ) {
    throw new SeasonalValidationError(
      "outside_season",
      "Latest Seasonal activity is outside the configured cycle"
    );
  }

  const info = requiredRecord(extracted.profile.info, "profile.info");
  const side = optionalString(info.side);
  const lifetimePvpHours = options.lifetimePvpHours === undefined
    ? totalInGameTimeHours(extracted.profile)
    : options.lifetimePvpHours;
  if (lifetimePvpHours !== null && (!Number.isFinite(lifetimePvpHours) || lifetimePvpHours < 0)) {
    throw new SeasonalValidationError(
      "invalid_payload",
      "lifetimePvpHours must be null or a non-negative finite number"
    );
  }

  const result: SeasonalProfile = {
    mode: "seasonal",
    cycleId: options.cycleId,
    aid: extracted.aid,
    nickname: requiredString(info.nickname, "profile.info.nickname"),
    ...(side ? { side } : {}),
    profileUpdatedAt,
    lastAccessAt,
    lifetimePvpHours,
    counters,
    staticSignals: parseStaticSignals(extracted.profile),
  };
  Object.defineProperty(result, "leaderboardActivityAt", { value: leaderboardActivityAt, enumerable: false });
  Object.defineProperty(result, "pvpStatsVersion", {
    value: pvpStatsVersion,
    enumerable: false,
  });
  Object.defineProperty(result, "pvpStatsParserVersion", { value: 1, enumerable: false });
  // Keep the legacy validator's enumerable payload stable for existing callers;
  // the richer portrait is still available to the storage boundary.
  Object.defineProperty(result, "seasonalStats", { value: seasonalStats, enumerable: false });
  Object.defineProperty(result, "seasonalAchievements", {
    value: seasonalAchievements,
    enumerable: false,
  });
  Object.defineProperty(result, "commonSkills", {
    value: commonSkills,
    enumerable: false,
  });
  Object.defineProperty(result, "weaponMastery", {
    value: weaponMastery,
    enumerable: false,
  });
  Object.defineProperty(result, "pvpEnrichment", {
    value: { lifetimeHours: lifetimePvpHours, achievementIds: [], achievementCount: null, profileUpdatedAt: null },
    enumerable: false,
    writable: true,
  });
  return result;
}

export function validateSeasonalProfile(
  payload: unknown,
  options: SeasonalAdapterOptions
): SeasonalValidationResult {
  try {
    return { ok: true, profile: parseSeasonalProfile(payload, options) };
  } catch (error) {
    if (error instanceof SeasonalValidationError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
