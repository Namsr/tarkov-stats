import { PlayerSearchResult, PlayerProfile } from "@/types/tarkov";

const PLAYER_API_BASE = "https://player.tarkov.dev";

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

export async function getPlayerLevels(): Promise<
  { level: number; exp: number }[]
> {
  const res = await fetch("https://api.tarkov.dev/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ playerLevels { level exp } }`,
    }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
  const data = await res.json();
  return data.data.playerLevels;
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
  return entry?.Value ?? 0;
}

export function parseProfileStats(profile: PlayerProfile) {
  const pmc = profile.pmcStats;
  const scav = profile.scavStats;

  const pmcRaids = pmc?.eft?.totalRaidCount ?? 0;
  const scavRaids = scav?.eft?.totalRaidCount ?? 0;
  const totalRaids = pmcRaids + scavRaids;

  const pmcSurvived = pmc?.eft?.survivedRaidCount ?? 0;
  const scavSurvived = scav?.eft?.survivedRaidCount ?? 0;
  const totalSurvived = pmcSurvived + scavSurvived;
  const survivalRate = totalRaids > 0 ? (totalSurvived / totalRaids) * 100 : 0;

  const pmcCounters = pmc?.overAllCounters?.Items ?? [];
  const scavCounters = scav?.overAllCounters?.Items ?? [];

  const pmcKills =
    getCounterValue(pmcCounters, "Kills") ||
    getCounterValue(pmcCounters, "Sessions", "Pmc", "Kills");
  const scavKills =
    getCounterValue(scavCounters, "Kills") ||
    getCounterValue(scavCounters, "Sessions", "Pmc", "Kills");
  const totalKills = pmcKills + scavKills;

  const pmcDeaths =
    getCounterValue(pmcCounters, "Deaths") ||
    getCounterValue(pmcCounters, "Sessions", "Pmc", "Deaths");
  const scavDeaths =
    getCounterValue(scavCounters, "Deaths") ||
    getCounterValue(scavCounters, "Sessions", "Pmc", "Deaths");
  const deaths = pmcDeaths + scavDeaths;

  const kdRatio = deaths > 0 ? totalKills / deaths : totalKills;
  const killsPerRaid = totalRaids > 0 ? totalKills / totalRaids : 0;

  const pmcTime = pmc?.totalInGameTime ?? 0;
  const scavTime = scav?.totalInGameTime ?? 0;
  const hoursPlayed = (pmcTime + scavTime) / 3600;

  const headshots = getCounterValue(pmcCounters, "HeadShots");
  const headshotRate = totalKills > 0 ? (headshots / totalKills) * 100 : 0;

  const longestWinStreak =
    getCounterValue(pmcCounters, "LongestWinStreak") ||
    getCounterValue(pmcCounters, "CurrentWinStreak");

  const avgLifespan =
    totalRaids > 0 ? (pmcTime + scavTime) / totalRaids / 60 : 0;

  const achievementsCount = profile.achievements
    ? Object.keys(profile.achievements).length
    : 0;

  return {
    nickname: profile.info?.nickname ?? profile.nickname ?? "Unknown",
    level: profile.info?.experience
      ? profile.level ?? 0
      : profile.level ?? 0,
    experience: profile.info?.experience ?? profile.experience ?? 0,
    side: profile.info?.side ?? "Unknown",
    totalRaids,
    pmcRaids,
    scavRaids,
    survivalRate: Math.round(survivalRate * 10) / 10,
    totalKills,
    killsPerRaid: Math.round(killsPerRaid * 100) / 100,
    kdRatio: Math.round(kdRatio * 100) / 100,
    deaths,
    hoursPlayed: Math.round(hoursPlayed * 10) / 10,
    longestWinStreak,
    achievementsCount,
    registrationDate: profile.info?.registrationDate ?? profile.registrationDate ?? 0,
    lastActiveDate: profile.info?.lastActiveDate ?? profile.lastActiveDate ?? 0,
    headshots,
    headshotRate: Math.round(headshotRate * 10) / 10,
    avgLifespan: Math.round(avgLifespan * 10) / 10,
    totalLootValue: 0,
  };
}
