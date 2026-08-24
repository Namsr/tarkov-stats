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
  stat?: {
    arenaOverAllCounters?: ArenaOverallCounters;
    totalInGameTime?: number;
    [key: string]: unknown;
  };
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

export type ArenaModeKey = "teamFight" | "lastHero" | "checkpoint" | "blastGang";

export interface ArenaCounterGroup {
  Counters?: Record<string, unknown> | ArenaCounterItem[] | { Items?: ArenaCounterItem[] };
  [key: string]: unknown;
}

export interface ArenaCounterItem {
  Key: string | string[];
  Value: number;
}

export interface ArenaOverallCounters {
  UnrankedOverall?: ArenaCounterGroup;
  UnrankedTeamFight?: ArenaCounterGroup;
  UnrankedLastHero?: ArenaCounterGroup;
  UnrankedCheckPoint?: ArenaCounterGroup;
  UnrankedBlastGang?: ArenaCounterGroup;
  [key: string]: unknown;
}

export interface ArenaModeStats {
  key: ArenaModeKey;
  kills: number;
  deaths: number;
  kdRatio: number;
  maxKillStreak: number;
  roundMvp: number;
  matchMvp: number;
  maxWinStreak: number;
}

export interface ArenaStats {
  currentKillStreak: number;
  maxKillStreak: number;
  maxWinStreak: number;
  bestArp: number;
  currentLossStreak: number;
  maxLossStreak: number;
  totalKills: number;
  totalDeaths: number;
  kdRatio: number;
  modes: ArenaModeStats[];
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
  Mastering?: MasteryEntry[];
  [key: string]: unknown;
}

export interface SkillEntry {
  Id: string;
  Progress: number;
  PointsEarnedDuringSession: number;
  LastAccess: number;
}

export interface MasteryEntry {
  Id: string;
  Progress: number;
}

export interface WeaponMasteryProgress {
  id: string;
  progress: number;
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
  /** Exact PMC kills against PMC while playing PMC (not Scav kills). */
  pmcKilledPmc: number;
  killedPmc: number;
  /** True when the exact PMC ["KilledPmc"] counter exists upstream (zero is valid). */
  pvpStatsKnown?: boolean;
  killsPerRaid: number;
  kdRatio: number;
  pmcKdRatio: number;
  deaths: number;
  pmcDeaths: number;
  runThrough: number;
  // PMC-only aggregates — the cheating-risk score is computed from these so that
  // easy, high-survival Scav raids can't mask (or fake) the signal.
  pmcSurvived: number;
  pmcSurvivalRate: number;
  pmcKills: number;
  pmcKillsPerRaid: number;
  // Full PMC raid-outcome breakdown (counts; sum to pmcRaids). runThrough above is
  // the "Runner" outcome — kept separately for the existing stat card.
  pmcExitKilled: number;
  pmcExitLeft: number;
  pmcExitTransit: number;
  pmcExitMia: number;
  hoursPlayed: number;
  longestWinStreak: number;
  achievementsCount: number;
  registrationDate: number;
  lastActiveDate: number;
  /** Upstream profile version, as a Unix ms timestamp. */
  profileUpdatedAt?: number;
  /** Latest progressed skill access, as a Unix ms timestamp. */
  lastPlayedAt?: number;
  avgLifespan: number;
  totalLootValue: number;
  arena?: ArenaStats;
  /** Normalized profile.skills.Mastering rows retained for stored profile views. */
  weaponMastery?: WeaponMasteryProgress[];
  [key: string]: unknown;
}
