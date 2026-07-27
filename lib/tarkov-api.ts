import type {
  PlayerSearchResult,
  PlayerProfile,
  ParsedPlayerStats,
  ArenaCounterItem,
  ArenaCounterGroup,
  ArenaModeKey,
  ArenaModeStats,
} from "@/types/tarkov";

export const TARKOV_JSON_USER_AGENT = "TarkovStats/0.1 (+https://tarkovstats.ru)";

/** Server-side JSON request with the identity required by tarkov.dev. */
export function fetchTarkovJson(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("User-Agent", TARKOV_JSON_USER_AGENT);
  return fetch(url, { ...init, headers });
}

/** Captcha-gated live service (nickname search + live account fetch). */
const PLAYER_API_BASE = "https://player.tarkov.dev";
/** Captcha-free static cache of already-viewed profiles, keyed by account id. */
const PUBLIC_PROFILE_BASE = "https://players.tarkov.dev";
const ITEMS_URL = "https://json.tarkov.dev/regular/items";
const TASKS_URL = "https://json.tarkov.dev/regular/tasks";
const TASKS_EN_URL = "https://json.tarkov.dev/regular/tasks_en";

/**
 * Nickname search. Requires a valid Cloudflare Turnstile token bound to
 * tarkov.dev's hostname, so it only works from a real browser session on
 * tarkov.dev — not server-to-server. Kept for reference / future use.
 */
export async function searchPlayer(
  nickname: string,
  turnstileToken?: string
): Promise<PlayerSearchResult[]> {
  const params = new URLSearchParams();
  if (turnstileToken) params.set("token", turnstileToken);
  const qs = params.toString();
  const url = `${PLAYER_API_BASE}/name/${encodeURIComponent(nickname)}${qs ? `?${qs}` : ""}`;

  const res = await fetchTarkovJson(url, { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`Player search failed: ${res.status}`);
  }
  return res.json();
}

/** Live, captcha-gated profile fetch by account id. Kept for reference. */
export async function getPlayerProfile(
  aid: number,
  turnstileToken?: string
): Promise<PlayerProfile> {
  const params = new URLSearchParams();
  if (turnstileToken) params.set("token", turnstileToken);
  const qs = params.toString();
  const url = `${PLAYER_API_BASE}/account/${aid}${qs ? `?${qs}` : ""}`;

  const res = await fetchTarkovJson(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Profile fetch failed: ${res.status}`);
  }
  return res.json();
}

// In-process кэш upstream-профилей по aid. Снижает удары по players.tarkov.dev
// (риск бана IP VPS / амплификации) и частоту записи одинаковых строк в БД.
// Кэшируем и 404 (null) — защита от перебора несуществующих id.
type CachedProfile = { profile: PlayerProfile | null; ts: number };
export type PublicProfileMode = "regular" | "pve" | "arena";
const PUBLIC_PROFILE_PATH: Record<PublicProfileMode, string> = {
  regular: "profile",
  pve: "pve",
  arena: "arena",
};
const profileCache = new Map<string, CachedProfile>();
const PROFILE_TTL_MS = 5 * 60 * 1000; // 5 минут
const PROFILE_CACHE_MAX = 2000;
const PROFILE_VERSION_TOLERANCE_MS = 1000;

function cacheProfile(key: string, profile: PlayerProfile | null, ts: number) {
  if (profileCache.size > PROFILE_CACHE_MAX) {
    for (const [k, v] of profileCache) {
      if (ts - v.ts >= PROFILE_TTL_MS) profileCache.delete(k);
    }
    if (profileCache.size > PROFILE_CACHE_MAX) profileCache.clear();
  }
  profileCache.set(key, { profile, ts });
}

export interface PublicProfileResult {
  profile: PlayerProfile | null;
  fromCache: boolean;
}

export class PublicProfileVersionConflictError extends Error {
  readonly code = "public_profile_version_conflict";
  readonly expectedUpdatedAt: number;
  readonly actualUpdatedAt: number | null;

  constructor(
    expectedUpdatedAt: number,
    actualUpdatedAt: number | null,
  ) {
    super(`Public profile version ${actualUpdatedAt ?? "missing"} is older than ${expectedUpdatedAt}`);
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.actualUpdatedAt = actualUpdatedAt;
  }
}

function profileUpdatedAt(value: unknown): number | null {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

/**
 * Captcha-free profile fetch by account id from the public static cache.
 * `profile` is null when not cached upstream (404). `fromCache` says whether the
 * result came from our in-process cache (caller can then skip the DB upsert).
 * Pass `{ force: true }` to bypass the in-process cache and always re-fetch
 * upstream (the explicit "Refresh" / page reload path).
 */
export async function getPublicProfile(
  aid: number,
  opts: { force?: boolean; mode?: PublicProfileMode; expectedUpdatedAt?: number } = {}
): Promise<PublicProfileResult> {
  const now = Date.now();
  const mode = opts.mode ?? "regular";
  const cacheKey = `${mode}:${aid}`;
  // force обходит in-process кэш: всё равно идём в upstream и перезаписываем кэш
  // свежим ответом (fromCache=false → вызывающий сделает upsert в БД).
  if (!opts.force) {
    const hit = profileCache.get(cacheKey);
    if (hit && now - hit.ts < PROFILE_TTL_MS) {
      return { profile: hit.profile, fromCache: true };
    }
  }

  const canonicalUrl = `${PUBLIC_PROFILE_BASE}/${PUBLIC_PROFILE_PATH[mode]}/${aid}.json`;
  const expectedUpdatedAt = mode === "regular"
    ? profileUpdatedAt(opts.expectedUpdatedAt)
    : null;
  const cacheBust = expectedUpdatedAt ?? now;
  const url = opts.force && mode === "regular" ? `${canonicalUrl}?v=${cacheBust}` : canonicalUrl;
  const res = await fetchTarkovJson(url, { cache: "no-store" });
  if (res.status === 404) {
    cacheProfile(cacheKey, null, now);
    return { profile: null, fromCache: false };
  }
  if (!res.ok) {
    throw new Error(`Public profile fetch failed: ${res.status}`);
  }
  const profile = (await res.json()) as PlayerProfile;
  if (Number(profile.aid) !== aid || !profile.info) {
    throw new Error("Public profile identity mismatch");
  }
  if (mode === "arena" && !profile.stat?.arenaOverAllCounters) {
    throw new Error("Public Arena profile schema mismatch");
  }
  if (mode === "pve" && (!profile.pmcStats?.eft || !Array.isArray(profile.skills?.Common))) {
    throw new Error("Public PVE profile schema mismatch");
  }
  const actualUpdatedAt = profileUpdatedAt(profile.updated);
  if (
    expectedUpdatedAt !== null &&
    (
      actualUpdatedAt === null ||
      actualUpdatedAt < expectedUpdatedAt - PROFILE_VERSION_TOLERANCE_MS
    )
  ) {
    throw new PublicProfileVersionConflictError(
      expectedUpdatedAt,
      actualUpdatedAt,
    );
  }
  if (expectedUpdatedAt !== null) {
    // updated.json is authoritative for sub-second serialization skew. Persist
    // its version so the completed queue item is not rediscovered every day.
    profile.updated = Math.max(actualUpdatedAt ?? expectedUpdatedAt, expectedUpdatedAt);
  }
  cacheProfile(cacheKey, profile, now);
  return { profile, fromCache: false };
}

export type PlayerLevel = { level: number; exp: number };

/** Known-good 2026-07-22 snapshot of JSON API incremental level XP. */
export const PLAYER_LEVELS_V2026_07_22: readonly PlayerLevel[] = [
  { level: 1, exp: 0 }, { level: 2, exp: 1000 }, { level: 3, exp: 3017 },
  { level: 4, exp: 4415 }, { level: 5, exp: 5824 }, { level: 6, exp: 7221 },
  { level: 7, exp: 8546 }, { level: 8, exp: 9913 }, { level: 9, exp: 11268 },
  { level: 10, exp: 12519 }, { level: 11, exp: 13840 }, { level: 12, exp: 15716 },
  { level: 13, exp: 22023 }, { level: 14, exp: 27951 }, { level: 15, exp: 34084 },
  { level: 16, exp: 40548 }, { level: 17, exp: 46547 }, { level: 18, exp: 52419 },
  { level: 19, exp: 57549 }, { level: 20, exp: 63065 }, { level: 21, exp: 67696 },
  { level: 22, exp: 72817 }, { level: 23, exp: 78369 }, { level: 24, exp: 84803 },
  { level: 25, exp: 94916 }, { level: 26, exp: 108067 }, { level: 27, exp: 122126 },
  { level: 28, exp: 133164 }, { level: 29, exp: 144320 }, { level: 30, exp: 155595 },
  { level: 31, exp: 166982 }, { level: 32, exp: 180344 }, { level: 33, exp: 196685 },
  { level: 34, exp: 215087 }, { level: 35, exp: 233690 }, { level: 36, exp: 258091 },
  { level: 37, exp: 281805 }, { level: 38, exp: 305744 }, { level: 39, exp: 326065 },
  { level: 40, exp: 346570 }, { level: 41, exp: 367261 }, { level: 42, exp: 388137 },
  { level: 43, exp: 416600 }, { level: 44, exp: 445333 }, { level: 45, exp: 474331 },
  { level: 46, exp: 528224 }, { level: 47, exp: 559155 }, { level: 48, exp: 590350 },
  { level: 49, exp: 621815 }, { level: 50, exp: 653537 }, { level: 51, exp: 685522 },
  { level: 52, exp: 717765 }, { level: 53, exp: 761235 }, { level: 54, exp: 805078 },
  { level: 55, exp: 849297 }, { level: 56, exp: 893877 }, { level: 57, exp: 938823 },
  { level: 58, exp: 984131 }, { level: 59, exp: 1029795 }, { level: 60, exp: 1095775 },
  { level: 61, exp: 1225050 }, { level: 62, exp: 1319453 }, { level: 63, exp: 1431321 },
  { level: 64, exp: 1558177 }, { level: 65, exp: 1748019 }, { level: 66, exp: 2002313 },
  { level: 67, exp: 2480456 }, { level: 68, exp: 3447343 }, { level: 69, exp: 4924970 },
  { level: 70, exp: 6306999 }, { level: 71, exp: 7640970 }, { level: 72, exp: 8986198 },
  { level: 73, exp: 10341135 }, { level: 74, exp: 11704613 }, { level: 75, exp: 13075721 },
  { level: 76, exp: 14453730 }, { level: 77, exp: 15838039 }, { level: 78, exp: 18623623 },
  { level: 79, exp: 27091684 },
];

let levelsCache: { data: PlayerLevel[]; ts: number } | null = null;
const LEVELS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validates the JSON API's incremental-XP level table at the trust boundary. */
export function parsePlayerLevels(payload: unknown): PlayerLevel[] {
  const data = record(record(payload)?.data);
  const rows = data?.playerLevels;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("playerLevels must be a non-empty array");
  }
  const seen = new Set<number>();
  const levels = rows.map((value, index) => {
    const row = record(value);
    const level = row?.level;
    const exp = row?.exp;
    if (typeof level !== "number" || !Number.isSafeInteger(level) || level <= 0) {
      throw new Error(`playerLevels[${index}].level must be a positive integer`);
    }
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp < 0) {
      throw new Error(`playerLevels[${index}].exp must be a finite non-negative number`);
    }
    if (seen.has(Number(level))) {
      throw new Error(`playerLevels contains duplicate level ${level}`);
    }
    seen.add(Number(level));
    return { level: Number(level), exp };
  });
  return levels.sort((a, b) => a.level - b.level);
}

/** Fetches levels once; failures return the versioned known-good local table. */
export async function loadPlayerLevels(
  request: typeof fetchTarkovJson = fetchTarkovJson
): Promise<PlayerLevel[]> {
  try {
    const response = await request(ITEMS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const levels = parsePlayerLevels(await response.json());
    console.info("tarkov reference", { reference: "playerLevels", source: "json" });
    return levels;
  } catch (error) {
    console.error(
      "tarkov reference validation failed",
      { reference: "playerLevels", error: error instanceof Error ? error.message : "unknown" }
    );
    const fallback = parsePlayerLevels({ data: { playerLevels: PLAYER_LEVELS_V2026_07_22 } });
    console.info("tarkov reference", { reference: "playerLevels", source: "local-fallback" });
    return fallback;
  }
}

/** Reference table mapping cumulative XP to character level, cached in-isolate. */
export async function getPlayerLevels(): Promise<PlayerLevel[]> {
  const now = Date.now();
  if (levelsCache && now - levelsCache.ts < LEVELS_TTL_MS) {
    console.info("tarkov reference", { reference: "playerLevels", source: "memory-cache" });
    return levelsCache.data;
  }
  const levels = await loadPlayerLevels();
  levelsCache = { data: levels, ts: now };
  return levels;
}

/**
 * Resolves a character level from total experience.
 * playerLevels[].exp is the XP required FOR each level (an increment), so the
 * level is the highest one whose cumulative (running-sum) requirement is met.
 */
export function expToLevel(exp: number, levels: PlayerLevel[]): number {
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  let cumulative = 0;
  let level = 0;
  for (const l of sorted) {
    cumulative += l.exp;
    if (exp >= cumulative) level = l.level;
    else break;
  }
  return level;
}

/** Static metadata for an achievement (names, rarity, BSG-wide completion %). */
export interface AchievementMeta {
  id: string;
  name: string;
  side: string;
  rarity: string;
  /** BSG's official share of ALL players who have it. */
  playersCompletedPercent: number;
  /** BSG's share among players who reached the relevant content. */
  adjustedPlayersCompletedPercent: number;
}

let achievementsCache: { data: Map<string, AchievementMeta>; ts: number } | null = null;
const ACHIEVEMENTS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function percentage(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${field} must be a percentage`);
  }
  return value;
}

function achievementTranslations(payload: unknown): Record<string, string> {
  const data = record(record(payload)?.data);
  if (!data) throw new Error("tasks_en.data must be an object");
  const translations: Record<string, string> = {};
  let usable = 0;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") throw new Error(`tasks_en.data.${key} must be a string`);
    translations[key] = value;
    if (value.trim() !== "") usable += 1;
  }
  if (usable === 0) throw new Error("tasks_en.data must contain translations");
  return translations;
}

/** Converts the JSON API achievement object into the existing metadata Map. */
export function parseAchievements(
  payload: unknown,
  translationsPayload?: unknown
): Map<string, AchievementMeta> {
  const achievements = record(record(record(payload)?.data)?.achievements);
  if (!achievements || Object.keys(achievements).length === 0) {
    throw new Error("tasks.data.achievements must be a non-empty object");
  }
  const translations = translationsPayload === undefined
    ? {}
    : achievementTranslations(translationsPayload);
  const result = new Map<string, AchievementMeta>();
  for (const [key, value] of Object.entries(achievements)) {
    const row = record(value);
    if (!row || typeof row.id !== "string" || row.id !== key) {
      throw new Error(`achievement ${key} has an invalid id`);
    }
    const translationKey = typeof row.name === "string" ? row.name : "";
    const translated = translations[translationKey]?.trim();
    const normalizedName = typeof row.normalizedName === "string"
      ? row.normalizedName.trim()
      : "";
    const rarity = row.normalizedRarity;
    if (rarity !== "common" && rarity !== "rare" && rarity !== "legendary") {
      throw new Error(`achievement ${key} has an invalid normalizedRarity`);
    }
    result.set(key, {
      id: key,
      name: translated || normalizedName || key,
      side: typeof row.side === "string" ? row.side : "",
      rarity,
      playersCompletedPercent: percentage(
        row.playersCompletedPercent,
        `achievement ${key}.playersCompletedPercent`
      ),
      adjustedPlayersCompletedPercent: percentage(
        row.adjustedPlayersCompletedPercent,
        `achievement ${key}.adjustedPlayersCompletedPercent`
      ),
    });
  }
  return result;
}

/** Achievement id -> metadata, cached in-isolate. Rarely changes (per wipe). */
export async function getAchievements(): Promise<Map<string, AchievementMeta>> {
  const now = Date.now();
  if (achievementsCache && now - achievementsCache.ts < ACHIEVEMENTS_TTL_MS) {
    console.info("tarkov reference", { reference: "achievements", source: "memory-cache" });
    return achievementsCache.data;
  }
  let tasks: unknown;
  try {
    const response = await fetchTarkovJson(TASKS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tasks = await response.json();
  } catch (error) {
    console.error("tarkov reference validation failed", {
      reference: "achievements",
      error: error instanceof Error ? error.message : "unknown",
    });
    const fallback = achievementsCache?.data ?? new Map();
    console.info("tarkov reference", {
      reference: "achievements",
      source: achievementsCache ? "memory-cache" : "local-fallback",
    });
    return fallback;
  }

  try {
    const response = await fetchTarkovJson(TASKS_EN_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const map = parseAchievements(tasks, await response.json());
    achievementsCache = { data: map, ts: now };
    console.info("tarkov reference", { reference: "achievements", source: "json" });
    return map;
  } catch (error) {
    console.error("tarkov reference validation failed", {
      reference: "achievements-translations",
      error: error instanceof Error ? error.message : "unknown",
    });
    if (achievementsCache) {
      console.info("tarkov reference", { reference: "achievements", source: "memory-cache" });
      return achievementsCache.data;
    }
    try {
      const fallback = parseAchievements(tasks);
      console.info("tarkov reference", { reference: "achievements", source: "local-fallback" });
      return fallback;
    } catch (tasksError) {
      console.error("tarkov reference validation failed", {
        reference: "achievements",
        error: tasksError instanceof Error ? tasksError.message : "unknown",
      });
      console.info("tarkov reference", { reference: "achievements", source: "local-fallback" });
      return new Map();
    }
  }
}

function getCounterValue(
  items: { Key: string[]; Value: number }[],
  ...keys: string[]
): number {
  const entry = items.find(
    (item) =>
      item.Key.length === keys.length &&
      keys.every((k, i) => item.Key[i] === k)
  );
  // Values come from untrusted external JSON — coerce and reject non-finite.
  const v = Number(entry?.Value);
  return Number.isFinite(v) ? v : 0;
}

function hasCounter(
  items: { Key: string[]; Value: number }[],
  ...keys: string[]
): boolean {
  return items.some(
    (item) =>
      item.Key.length === keys.length &&
      keys.every((key, index) => item.Key[index] === key)
  );
}

const round = (n: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export const PVE_SKILL_CUTOFF_SECONDS = Date.parse("2025-11-15T00:00:00+03:00") / 1000;
export type PveProfileDecision =
  | { state: "store"; lastSkillAccess: number }
  | { state: "skipped_before_cutoff"; lastSkillAccess: number }
  | { state: "skipped_missing_skill_date"; lastSkillAccess: null };

export function lastSkillAccessSeconds(profile: PlayerProfile): number | null {
  const accesses = (profile.skills?.Common ?? [])
    .filter((skill) => Number(skill.Progress) > 0)
    .map((skill) => Number(skill.LastAccess))
    .filter((value) => Number.isFinite(value) && value > 0);
  return accesses.length > 0 ? Math.max(...accesses) : null;
}

export function pveProfileDecision(profile: PlayerProfile): PveProfileDecision {
  const lastSkillAccess = lastSkillAccessSeconds(profile);
  if (lastSkillAccess === null) {
    return { state: "skipped_missing_skill_date", lastSkillAccess: null };
  }
  return {
    state: lastSkillAccess >= PVE_SKILL_CUTOFF_SECONDS ? "store" : "skipped_before_cutoff",
    lastSkillAccess,
  };
}

function arenaCounter(group: ArenaCounterGroup | undefined, key: string): number {
  const counters = group?.Counters;
  if (!counters) return 0;
  const fromItems = (items: ArenaCounterItem[]) => {
    const item = items.find(
      ({ Key }) => Key === key || (Array.isArray(Key) && Key.length === 1 && Key[0] === key)
    );
    const value = Number(item?.Value);
    return Number.isFinite(value) ? value : 0;
  };
  if (Array.isArray(counters)) return fromItems(counters);
  if (typeof counters !== "object") return 0;
  const items = (counters as { Items?: unknown }).Items;
  if (Array.isArray(items)) return fromItems(items as ArenaCounterItem[]);
  const value = Number((counters as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : 0;
}

const ARENA_MODES: readonly [ArenaModeKey, string][] = [
  ["teamFight", "UnrankedTeamFight"],
  ["lastHero", "UnrankedLastHero"],
  ["checkpoint", "UnrankedCheckPoint"],
  ["blastGang", "UnrankedBlastGang"],
];

/** Parses Arena's separate counter tree into the shared stored-stat envelope. */
export function parseArenaProfileStats(profile: PlayerProfile): ParsedPlayerStats {
  const counters = profile.stat?.arenaOverAllCounters;
  const modes: ArenaModeStats[] = ARENA_MODES.map(([key, upstreamKey]) => {
    const group = counters?.[upstreamKey] as ArenaCounterGroup | undefined;
    const kills = arenaCounter(group, "Kills");
    const deaths = arenaCounter(group, "Deaths");
    return {
      key,
      kills,
      deaths,
      kdRatio: round(deaths > 0 ? kills / deaths : kills),
      maxKillStreak: arenaCounter(group, "MaxKillsWithoutDeaths"),
      roundMvp: arenaCounter(group, "RoundMvpCount"),
      matchMvp: arenaCounter(group, "MatchMvpCount"),
      maxWinStreak: arenaCounter(group, "LongestWinStreak"),
    };
  });
  const totalKills = modes.reduce((sum, mode) => sum + mode.kills, 0);
  const totalDeaths = modes.reduce((sum, mode) => sum + mode.deaths, 0);
  const overall = counters?.UnrankedOverall;
  const totalInGameTime = Number(profile.stat?.totalInGameTime);
  const hoursPlayed = round(
    Number.isFinite(totalInGameTime) && totalInGameTime > 0 ? totalInGameTime / 3600 : 0,
    1
  );
  const arena = {
    currentKillStreak: arenaCounter(overall, "KillsWithoutDeaths"),
    maxKillStreak: arenaCounter(overall, "MaxKillsWithoutDeaths"),
    maxWinStreak: arenaCounter(overall, "LongestWinStreak"),
    bestArp: arenaCounter(overall, "BestArp"),
    currentLossStreak: arenaCounter(overall, "LoseStreak"),
    maxLossStreak: arenaCounter(overall, "LongestLoseStreak"),
    totalKills,
    totalDeaths,
    kdRatio: round(totalDeaths > 0 ? totalKills / totalDeaths : totalKills),
    modes,
  };

  return {
    nickname: profile.info?.nickname ?? profile.nickname ?? "Unknown",
    level: 0,
    prestige: profile.info?.prestigeLevel ?? 0,
    experience: profile.info?.experience ?? profile.experience ?? 0,
    side: profile.info?.side ?? "Unknown",
    totalRaids: 0,
    pmcRaids: 0,
    scavRaids: 0,
    survivedRaids: 0,
    survivalRate: 0,
    totalKills,
    killedPmc: 0,
    pvpStatsKnown: false,
    killsPerRaid: 0,
    kdRatio: arena.kdRatio,
    pmcKdRatio: 0,
    deaths: totalDeaths,
    pmcDeaths: 0,
    runThrough: 0,
    pmcSurvived: 0,
    pmcSurvivalRate: 0,
    pmcKills: 0,
    pmcKillsPerRaid: 0,
    pmcExitKilled: 0,
    pmcExitLeft: 0,
    pmcExitTransit: 0,
    pmcExitMia: 0,
    hoursPlayed,
    longestWinStreak: arena.maxWinStreak,
    achievementsCount: 0,
    registrationDate: profile.info?.registrationDate ?? 0,
    lastActiveDate: profile.info?.lastActiveDate ?? 0,
    profileUpdatedAt: profileUpdatedAt(profile.updated) ?? 0,
    avgLifespan: 0,
    totalLootValue: 0,
    arena,
  };
}

/**
 * Parses the real public profile payload into flat stats.
 * Real schema: profile.{pmc,scav}Stats.eft.{totalInGameTime, overAllCounters.Items}
 * with counters keyed like ["Sessions","Pmc"], ["ExitStatus","Survived","Pmc"],
 * ["Deaths"], ["Kills"], ["KilledPmc"], ["LongestWinStreak","Pmc"], etc.
 */
export function parseProfileStats(
  profile: PlayerProfile,
  levels?: PlayerLevel[]
): ParsedPlayerStats {
  const pmcEft = profile.pmcStats?.eft;
  const scavEft = profile.scavStats?.eft;
  const pmcCounters = pmcEft?.overAllCounters?.Items ?? [];
  const scavCounters = scavEft?.overAllCounters?.Items ?? [];

  const pmcRaids = getCounterValue(pmcCounters, "Sessions", "Pmc");
  const scavRaids = getCounterValue(scavCounters, "Sessions", "Scav");
  const totalRaids = pmcRaids + scavRaids;

  const pmcSurvived = getCounterValue(pmcCounters, "ExitStatus", "Survived", "Pmc");
  const scavSurvived = getCounterValue(scavCounters, "ExitStatus", "Survived", "Scav");
  const survivedRaids = pmcSurvived + scavSurvived;
  const survivalRate = totalRaids > 0 ? (survivedRaids / totalRaids) * 100 : 0;

  const pmcKills = getCounterValue(pmcCounters, "Kills");
  const scavKills = getCounterValue(scavCounters, "Kills");
  const totalKills = pmcKills + scavKills;

  const pmcDeaths = getCounterValue(pmcCounters, "Deaths");
  const scavDeaths = getCounterValue(scavCounters, "Deaths");
  const deaths = pmcDeaths + scavDeaths;

  const pmcKilledPmc = getCounterValue(pmcCounters, "KilledPmc");
  const scavKilledPmc = getCounterValue(scavCounters, "KilledPmc");
  const killedPmc = pmcKilledPmc + scavKilledPmc;

  const runThrough = getCounterValue(pmcCounters, "ExitStatus", "Runner", "Pmc");

  // Full PMC raid-outcome breakdown. Survived (pmcSurvived) and Runner (runThrough)
  // are computed above; these are the remaining outcomes. Together they partition
  // every PMC session (sum ≈ pmcRaids).
  const pmcExitKilled = getCounterValue(pmcCounters, "ExitStatus", "Killed", "Pmc");
  const pmcExitLeft = getCounterValue(pmcCounters, "ExitStatus", "Left", "Pmc");
  const pmcExitTransit = getCounterValue(pmcCounters, "ExitStatus", "Transit", "Pmc");
  const pmcExitMia = getCounterValue(pmcCounters, "ExitStatus", "MissingInAction", "Pmc");

  const kdRatio = deaths > 0 ? totalKills / deaths : totalKills;
  const pmcKdRatio = pmcDeaths > 0 ? pmcKilledPmc / pmcDeaths : pmcKilledPmc;
  const killsPerRaid = totalRaids > 0 ? totalKills / totalRaids : 0;

  // PMC-only versions of survival and kills-per-raid — these feed the cheating-risk
  // score (Scav raids excluded). pmcKills is all kills made while playing PMC.
  const pmcSurvivalRate = pmcRaids > 0 ? (pmcSurvived / pmcRaids) * 100 : 0;
  const pmcKillsPerRaid = pmcRaids > 0 ? pmcKills / pmcRaids : 0;

  // totalInGameTime is an account-wide value duplicated in both pmcStats.eft and
  // scavStats.eft (same number), so we take it once rather than summing.
  const inGameSeconds = pmcEft?.totalInGameTime ?? scavEft?.totalInGameTime ?? 0;
  const hoursPlayed = inGameSeconds / 3600;
  const avgLifespan = totalRaids > 0 ? inGameSeconds / totalRaids / 60 : 0;

  const longestWinStreak = getCounterValue(pmcCounters, "LongestWinStreak", "Pmc");

  const achievementsCount = profile.achievements
    ? Object.keys(profile.achievements).length
    : 0;

  const experience = profile.info?.experience ?? profile.experience ?? 0;
  const level = levels && levels.length > 0 ? expToLevel(experience, levels) : 0;

  return {
    nickname: profile.info?.nickname ?? profile.nickname ?? "Unknown",
    level,
    prestige: profile.info?.prestigeLevel ?? 0,
    experience,
    side: profile.info?.side ?? "Unknown",
    totalRaids,
    pmcRaids,
    scavRaids,
    survivedRaids,
    survivalRate: round(survivalRate, 1),
    totalKills,
    killedPmc,
    pvpStatsKnown: hasCounter(pmcCounters, "KilledPmc"),
    killsPerRaid: round(killsPerRaid),
    kdRatio: round(kdRatio),
    pmcKdRatio: round(pmcKdRatio),
    deaths,
    pmcDeaths,
    runThrough,
    pmcSurvived,
    pmcSurvivalRate: round(pmcSurvivalRate, 1),
    pmcKills,
    pmcKillsPerRaid: round(pmcKillsPerRaid),
    pmcExitKilled,
    pmcExitLeft,
    pmcExitTransit,
    pmcExitMia,
    hoursPlayed: round(hoursPlayed, 1),
    longestWinStreak,
    achievementsCount,
    registrationDate: profile.info?.registrationDate ?? 0,
    lastActiveDate: profile.info?.lastActiveDate ?? 0,
    profileUpdatedAt: profileUpdatedAt(profile.updated) ?? 0,
    lastPlayedAt: (lastSkillAccessSeconds(profile) ?? 0) * 1000,
    avgLifespan: round(avgLifespan, 1),
    totalLootValue: 0,
  };
}
