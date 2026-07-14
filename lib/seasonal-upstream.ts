import type {
  CycleId,
  SeasonalCounters,
  SeasonalProfile,
  SeasonCycle,
} from "@/types/seasonal";

export type SeasonalUpstreamContract = NonNullable<SeasonCycle["upstreamContract"]>;

export interface SeasonalAdapterOptions {
  /** Seasonal remains fail-closed until rollout explicitly enables it. */
  enabled: boolean;
  /** The contract confirmed by a real upstream JSON fixture. */
  confirmedContract: SeasonalUpstreamContract | null;
  cycleId: CycleId;
  seasonStartsAt: number;
  seasonEndsAt?: number | null;
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

function parseCounters(profile: UnknownRecord): SeasonalCounters {
  const info = requiredRecord(profile.info, "profile.info");
  const pmc = counterItems(profile.pmcStats, "profile.pmcStats");
  const scav = counterItems(profile.scavStats, "profile.scavStats");

  const counters = {
    experience: nonNegativeInteger(info.experience, "profile.info.experience"),
    pmcRaids: counterValue(pmc, "Sessions", "Pmc"),
    scavRaids: counterValue(scav, "Sessions", "Scav"),
    pmcSurvived: counterValue(pmc, "ExitStatus", "Survived", "Pmc"),
    pmcDeaths: counterValue(pmc, "Deaths"),
    pmcKills: counterValue(pmc, "Kills"),
    killedPmc: counterValue(pmc, "KilledPmc"),
  };
  return counters;
}

function parseStaticSignals(profile: UnknownRecord) {
  const info = requiredRecord(profile.info, "profile.info");
  const pmc = counterItems(profile.pmcStats, "profile.pmcStats");
  const achievements = profile.achievements === undefined
    ? {}
    : requiredRecord(profile.achievements, "profile.achievements");
  return {
    prestige: info.prestigeLevel === undefined
      ? 0
      : nonNegativeInteger(info.prestigeLevel, "profile.info.prestigeLevel"),
    longestWinStreak: counterValue(pmc, "LongestWinStreak", "Pmc"),
    achievementIds: Object.keys(achievements).sort(),
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
        candidates.push(
          unixMilliseconds(skill.LastAccess, `profile.skills.Common[${index}].LastAccess`)
        );
      }
    });
  }

  if (root.achievements !== undefined) {
    const achievements = requiredRecord(root.achievements, "profile.achievements");
    Object.entries(achievements).forEach(([id, timestamp]) => {
      candidates.push(unixMilliseconds(timestamp, `profile.achievements.${id}`));
    });
  }

  if (candidates.length === 0) {
    throw new SeasonalValidationError(
      "invalid_payload",
      "profile must contain at least one skill or achievement activity timestamp"
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
  const extracted =
    options.confirmedContract === "game_mode"
      ? extractGameModeContract(root)
      : extractProfileSectionContract(root);

  if (extracted.cycleId !== options.cycleId) {
    throw new SeasonalValidationError(
      "cycle_mismatch",
      `Expected cycle ${options.cycleId}, received ${extracted.cycleId}`
    );
  }

  const counters = parseCounters(extracted.profile);
  if (counters.pmcRaids + counters.scavRaids === 0) {
    throw new SeasonalValidationError(
      "no_completed_raids",
      "Seasonal profile has no completed PMC or Scav raids"
    );
  }
  validateCounterRelationships(counters);

  const lastAccessAt = seasonalLastAccess(extracted.profile);
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
  const lifetimePvpHours = options.lifetimePvpHours ?? null;
  if (lifetimePvpHours !== null && (!Number.isFinite(lifetimePvpHours) || lifetimePvpHours < 0)) {
    throw new SeasonalValidationError(
      "invalid_payload",
      "lifetimePvpHours must be null or a non-negative finite number"
    );
  }

  return {
    mode: "seasonal",
    cycleId: options.cycleId,
    aid: extracted.aid,
    nickname: requiredString(info.nickname, "profile.info.nickname"),
    profileUpdatedAt,
    lastAccessAt,
    lifetimePvpHours,
    counters,
    staticSignals: parseStaticSignals(extracted.profile),
  };
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
