export interface PlayerSearchResult {
  aid: number;
  name: string;
}

export interface PlayerProfile {
  aid: number;
  nickname: string;
  experience: number;
  level: number;
  registrationDate: number;
  lastActiveDate: number;
  bannedUntil: number;
  isBanned: boolean;
  gameEdition: string;
  memberCategory: number;
  selectedMemberCategory: number;
  info: {
    side: string;
    experience: number;
    registrationDate: number;
    lastActiveDate: number;
    bannedUntil: number;
    isBanned: boolean;
    nickname: string;
    memberCategory: number;
    selectedMemberCategory: number;
    gameEdition: string;
  };
  pmcStats: RaidStats;
  scavStats: RaidStats;
  achievements: Record<string, number>;
  skills: SkillData;
  favoriteWeapons: WeaponStat[];
  [key: string]: unknown;
}

export interface RaidStats {
  totalInGameTime: number;
  overAllCounters: OverallCounters;
  eft: {
    totalRaidCount: number;
    survivedRaidCount: number;
    killedRaidCount: number;
    missInActionRaidCount: number;
    runThroughRaidCount: number;
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

export interface BenchmarkBucket {
  label: string;
  minRaids: number;
  maxRaids: number;
  sampleSize: number;
  medianKD: number;
  medianSurvivalRate: number;
  medianKillsPerRaid: number;
  medianTotalKills: number;
  medianRaids: number;
}

export interface Streamer {
  name: string;
  nickname: string;
}

export interface ParsedPlayerStats {
  nickname: string;
  level: number;
  experience: number;
  side: string;
  totalRaids: number;
  pmcRaids: number;
  scavRaids: number;
  survivalRate: number;
  totalKills: number;
  killsPerRaid: number;
  kdRatio: number;
  deaths: number;
  hoursPlayed: number;
  longestWinStreak: number;
  achievementsCount: number;
  registrationDate: number;
  lastActiveDate: number;
  headshots: number;
  headshotRate: number;
  avgLifespan: number;
  totalLootValue: number;
  [key: string]: unknown;
}
