import type { PlayerSearchProfileResult, PlayerSearchResult } from "@/types/tarkov";

export interface PlayerSearchIndexMatch extends PlayerSearchProfileResult {
  aid: number;
}

export type RecentSearchMode = "regular" | "pve" | "arena" | "seasonal" | "pvp-season";

export interface RecentSearchEntry {
  aid: string | number;
  mode: RecentSearchMode;
}

const MODE_ORDER = new Map([
  ["regular", 0],
  ["pve", 1],
  ["arena", 2],
  ["seasonal", 3],
]);

function normalizedTimestamp(value: unknown): number | null {
  if (value == null) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function recentProfileMode(mode: RecentSearchMode): PlayerSearchProfileResult["mode"] {
  return mode === "pvp-season" ? "seasonal" : mode;
}

function newestProfile(profiles: readonly PlayerSearchProfileResult[]): PlayerSearchProfileResult | null {
  let newest: PlayerSearchProfileResult | null = null;
  let newestTimestamp: number | null = null;
  for (const profile of profiles) {
    const timestamp = normalizedTimestamp(profile.updatedAt);
    if (timestamp === null || (newestTimestamp !== null && timestamp <= newestTimestamp)) continue;
    newest = profile;
    newestTimestamp = timestamp;
  }
  return newest;
}

/** Selects the profile opened by a whole-row search result. */
export function selectPlayerSearchProfile(
  aid: number,
  profiles: readonly PlayerSearchProfileResult[],
  nickname: string,
  recentPlayers: readonly RecentSearchEntry[] = [],
): PlayerSearchProfileResult | null {
  if (profiles.length === 0) return null;

  const query = nickname.trim().toLowerCase();
  const exact = profiles.filter((profile) => profile.name.trim().toLowerCase() === query);
  const recent = recentPlayers.find((entry) => String(entry.aid) === String(aid));
  const recentMode = recent ? recentProfileMode(recent.mode) : null;

  if (exact.length > 0) {
    if (recentMode) {
      const recentExact = exact.find((profile) => profile.mode === recentMode);
      if (recentExact) return recentExact;
    }
    return newestProfile(exact) ?? exact[0];
  }

  if (recentMode) {
    const recentProfile = profiles.find((profile) => profile.mode === recentMode);
    if (recentProfile) return recentProfile;
  }
  return newestProfile(profiles) ?? profiles[0];
}

function compareProfiles(query: string) {
  return (a: PlayerSearchProfileResult, b: PlayerSearchProfileResult) => {
    const aName = a.name.trim().toLowerCase();
    const bName = b.name.trim().toLowerCase();
    const exact = Number(bName === query) - Number(aName === query);
    if (exact !== 0) return exact;
    return aName.localeCompare(bName) ||
      (MODE_ORDER.get(a.mode) ?? 99) - (MODE_ORDER.get(b.mode) ?? 99);
  };
}

export function groupPlayerSearchResults(
  matches: readonly PlayerSearchIndexMatch[],
  nickname: string,
  limit: number,
): PlayerSearchResult[] {
  const query = nickname.trim().toLowerCase();
  const grouped = new Map<number, PlayerSearchProfileResult[]>();
  for (const match of matches) {
    const profiles = grouped.get(match.aid) ?? [];
    if (!profiles.some((profile) =>
      profile.mode === match.mode && profile.cycleId === match.cycleId
    )) {
      profiles.push({
        mode: match.mode,
        cycleId: match.cycleId,
        name: match.name,
        updatedAt: normalizedTimestamp(match.updatedAt),
      });
    }
    grouped.set(match.aid, profiles);
  }

  return [...grouped.entries()].map(([aid, unsorted]) => {
    const profiles = [...unsorted].sort(compareProfiles(query));
    return { aid, name: profiles[0]?.name ?? String(aid), profiles };
  }).sort((a, b) => {
    const aExact = a.profiles.some((profile) => profile.name.trim().toLowerCase() === query);
    const bExact = b.profiles.some((profile) => profile.name.trim().toLowerCase() === query);
    return Number(bExact) - Number(aExact) ||
      a.name.trim().toLowerCase().localeCompare(b.name.trim().toLowerCase()) ||
      a.aid - b.aid;
  }).slice(0, limit);
}
