export interface PlayerSearchResult {
  aid: number;
  name: string;
}

/**
 * Shape of the public profile JSON served by https://players.tarkov.dev/profile/{aid}.json
 * Only the fields we actually rely on are typed strictly; the rest is left open.
 */
export interface PlayerProfile {
  aid: number;
  info: {
    nickname: string;
    side: string;
    experience: number;
    memberCategory?: number;
    selectedMemberCategory?: number;
    prestigeLevel?: number;
    // The following are NOT present in the public profile payload, kept optional
    // for backwards-compatibility with older callers.
    registrationDate?: number;
    lastActiveDate?: number;
  };
  pmcStats?: RaidStats;
  scavStats?: RaidStats;
  achievements?: Record<string, number>;
  skills?: SkillData;
  /** Unix ms timestamp of when tarkov.dev last refreshed this cached profile. */
  updated?: number;
  // Legacy/optional top-level fallbacks (not present in real payload).
  nickname?: string;
  experience?: number;
  level?: number;
  registrationDate?: number;
  lastActiveDate?: number;
  [key: string]: unknown;
}

export interface RaidStats {
  eft: {
    totalInGameTime: number;
    overAllCounters: OverallCounters;
    [key: string]: unknown;
  };
}

export interface OverallCounters {
  Items: CounterItem[];
}

export interface CounterItem {
  Key: string[];
  Value: number;
}

export interface SkillData {
  Common: SkillEntry[];
  [key: string]: unknown;
}

export interface SkillEntry {
  Id: string;
  Progress: number;
  PointsEarnedDuringSession: number;
  LastAccess: number;
}

export interface WeaponStat {
  Name: string;
  Count: number;
}

export interface Streamer {
  name: string;
  nickname: string;
}

export interface ParsedPlayerStats {
  nickname: string;
  level: number;
  prestige: number;
  experience: number;
  side: string;
  totalRaids: number;
  pmcRaids: number;
  scavRaids: number;
  survivedRaids: number;
  survivalRate: number;
  totalKills: number;
  killedPmc: number;
  killsPerRaid: number;
  kdRatio: number;
  pmcKdRatio: number;
  deaths: number;
  pmcDeaths: number;
  runThrough: number;
  hoursPlayed: number;
  longestWinStreak: number;
  achievementsCount: number;
  registrationDate: number;
  lastActiveDate: number;
  avgLifespan: number;
  totalLootValue: number;
  [key: string]: unknown;
}
