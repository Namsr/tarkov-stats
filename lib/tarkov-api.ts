import type {
  PlayerSearchResult,
  PlayerProfile,
  ParsedPlayerStats,
  ArenaCounterItem,
  ArenaCounterGroup,
  ArenaModeKey,
  ArenaModeStats,
} from "@/types/tarkov";

/** Captcha-gated live service (nickname search + live account fetch). */
const PLAYER_API_BASE = "https://player.tarkov.dev";
/** Captcha-free static cache of already-viewed profiles, keyed by account id. */
const PUBLIC_PROFILE_BASE = "https://players.tarkov.dev";

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

  const res = await fetch(url);
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

  const res = await fetch(url);
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

/**
 * Captcha-free profile fetch by account id from the public static cache.
 * `profile` is null when not cached upstream (404). `fromCache` says whether the
 * result came from our in-process cache (caller can then skip the DB upsert).
 * Pass `{ force: true }` to bypass the in-process cache and always re-fetch
 * upstream (the explicit "Refresh" / page reload path).
 */
export async function getPublicProfile(
  aid: number,
  opts: { force?: boolean; mode?: PublicProfileMode } = {}
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

  const url = `${PUBLIC_PROFILE_BASE}/${PUBLIC_PROFILE_PATH[mode]}/${aid}.json`;
  const res = await fetch(url);
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
  cacheProfile(cacheKey, profile, now);
  return { profile, fromCache: false };
}

type PlayerLevel = { level: number; exp: number };

let levelsCache: { data: PlayerLevel[]; ts: number } | null = null;
const LEVELS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Reference table mapping cumulative XP to character level, cached in-isolate. */
export async function getPlayerLevels(): Promise<PlayerLevel[]> {
  const now = Date.now();
  if (levelsCache && now - levelsCache.ts < LEVELS_TTL_MS) {
    return levelsCache.data;
  }
  const res = await fetch("https://api.tarkov.dev/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ playerLevels { level exp } }` }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
  const data = (await res.json()) as { data: { playerLevels: PlayerLevel[] } };
  const levels = [...data.data.playerLevels].sort((a, b) => a.exp - b.exp);
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

/** Achievement id -> metadata, cached in-isolate. Rarely changes (per wipe). */
export async function getAchievements(): Promise<Map<string, AchievementMeta>> {
  const now = Date.now();
  if (achievementsCache && now - achievementsCache.ts < ACHIEVEMENTS_TTL_MS) {
    return achievementsCache.data;
  }
  const res = await fetch("https://api.tarkov.dev/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query:
        `{ achievements { id name side rarity playersCompletedPercent adjustedPlayersCompletedPercent } }`,
    }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
  const data = (await res.json()) as { data: { achievements: AchievementMeta[] } };
  const map = new Map((data.data.achievements ?? []).map((a) => [a.id, a]));
  achievementsCache = { data: map, ts: now };
  return map;
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

const round = (n: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export const PVE_SKILL_CUTOFF_SECONDS = Date.parse("2025-11-15T00:00:00+03:00") / 1000;
export type PveProfileDecision =
  | { state: "store"; lastSkillAccess: number }
  | { state: "skipped_before_cutoff"; lastSkillAccess: number }
  | { state: "skipped_missing_skill_date"; lastSkillAccess: null };

export function pveProfileDecision(profile: PlayerProfile): PveProfileDecision {
  const accesses = (profile.skills?.Common ?? [])
    .filter((skill) => Number(skill.Progress) > 0)
    .map((skill) => Number(skill.LastAccess))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (accesses.length === 0) {
    return { state: "skipped_missing_skill_date", lastSkillAccess: null };
  }
  const lastSkillAccess = Math.max(...accesses);
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
    avgLifespan: round(avgLifespan, 1),
    totalLootValue: 0,
  };
}
