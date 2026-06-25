import { PlayerSearchResult, PlayerProfile, ParsedPlayerStats } from "@/types/tarkov";

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
const profileCache = new Map<number, CachedProfile>();
const PROFILE_TTL_MS = 5 * 60 * 1000; // 5 минут
const PROFILE_CACHE_MAX = 2000;

function cacheProfile(aid: number, profile: PlayerProfile | null, ts: number) {
  if (profileCache.size > PROFILE_CACHE_MAX) {
    for (const [k, v] of profileCache) {
      if (ts - v.ts >= PROFILE_TTL_MS) profileCache.delete(k);
    }
    if (profileCache.size > PROFILE_CACHE_MAX) profileCache.clear();
  }
  profileCache.set(aid, { profile, ts });
}

export interface PublicProfileResult {
  profile: PlayerProfile | null;
  fromCache: boolean;
}

/**
 * Captcha-free profile fetch by account id from the public static cache.
 * `profile` is null when not cached upstream (404). `fromCache` says whether the
 * result came from our in-process cache (caller can then skip the DB upsert).
 */
export async function getPublicProfile(aid: number): Promise<PublicProfileResult> {
  const now = Date.now();
  const hit = profileCache.get(aid);
  if (hit && now - hit.ts < PROFILE_TTL_MS) {
    return { profile: hit.profile, fromCache: true };
  }

  const url = `${PUBLIC_PROFILE_BASE}/profile/${aid}.json`;
  const res = await fetch(url);
  if (res.status === 404) {
    cacheProfile(aid, null, now);
    return { profile: null, fromCache: false };
  }
  if (!res.ok) {
    throw new Error(`Public profile fetch failed: ${res.status}`);
  }
  const profile = (await res.json()) as PlayerProfile;
  cacheProfile(aid, profile, now);
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
