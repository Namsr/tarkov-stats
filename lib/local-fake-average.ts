import { bracketFor } from "@/lib/brackets";
import type { AveragePeriod, AverageStatistic, RangeDimension } from "@/lib/db";
import type { ProgressionAverageResponse, ProgressionKind, ProgressionPoint, SeasonalAverageSeries } from "@/types/seasonal";

export function isLocalFakeAverageEnabled(): boolean {
  return process.env.LOCAL_FAKE_AVERAGE === "1";
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAKE_N = 12480;

const FAKE_AVERAGES: Record<string, number> = {
  hours: 612,
  total_raids: 388,
  pmc_raids: 271,
  scav_raids: 117,
  survived: 171,
  deaths: 204,
  pmc_deaths: 148,
  total_kills: 693,
  killed_pmc: 246,
  run_through: 13,
  longest_win_streak: 4.2,
  kd_ratio: 3.4,
  pmc_kd_ratio: 1.66,
  survival_rate: 44.1,
  kills_per_raid: 1.79,
  pmc_survival_rate: 41.8,
  pmc_kills_per_raid: 0.91,
  achv_count: 9.4,
  level: 38,
  prestige: 0.12,
  experience: 512000,
};

interface FakeBucket {
  lo: number;
  hi: number | null;
  n: number;
  sum: number;
}

function fakeBuckets(dimension: RangeDimension, metricAvg: number): FakeBucket[] {
  const rand = mulberry32(dimension === "hours" ? 42 : 777);
  const step = (lo: number) => (dimension === "hours" ? (lo < 2000 ? 50 : 100) : lo < 1000 ? 25 : 50);
  const cap = dimension === "hours" ? 10000 : 3000;
  const out: FakeBucket[] = [];
  for (let lo = 0; lo < cap; lo += step(lo)) {
    const mid = lo + step(lo) / 2;
    const spread = dimension === "hours" ? 900 : 320;
    const center = dimension === "hours" ? 550 : 260;
    const density = Math.exp(-((mid - center) ** 2) / (2 * spread * spread));
    const n = Math.max(4, Math.round(460 * density + rand() * 22));
    const growth = 0.55 + (mid / cap) * 1.1;
    out.push({ lo, hi: lo + step(lo), n, sum: +(metricAvg * growth * n).toFixed(2) });
  }
  const last = out[out.length - 1];
  last.hi = null;
  last.n = Math.max(6, Math.round(last.n * 0.4));
  return out;
}

export function fakeAverageDashboard(args: {
  mode: "regular" | "pve";
  dimension: RangeDimension;
  metric: string;
  statistic: AverageStatistic;
  period: AveragePeriod;
  min?: number | null;
  max?: number | null;
}): Record<string, unknown> {
  const { mode, dimension, metric, statistic, period } = args;
  const span = dimension === "hours" ? 5000 : 1000;
  const mid = args.min != null && args.max != null ? (args.min + args.max) / 2 : span / 2;
  const factor = 1 + ((mid - span / 2) / span) * 0.3;
  const scaled: Record<string, number> = {};
  for (const [key, value] of Object.entries(FAKE_AVERAGES)) {
    scaled[key] = key === "prestige" ? value : +(value * factor).toFixed(2);
  }
  const total = args.min != null && args.max != null
    ? Math.max(120, Math.round(FAKE_N * (Math.max(0, args.max - args.min) / span)))
    : FAKE_N;
  const metricAvg = scaled[metric] ?? total;
  const buckets = fakeBuckets(dimension, typeof metricAvg === "number" ? metricAvg : total);
  const bucketTotal = buckets.reduce((sum, bucket) => sum + bucket.n, 0);
  const metricCounts: Record<string, number> = {};
  for (const key of Object.keys(FAKE_AVERAGES)) metricCounts[key] = total;
  return {
    mode,
    cycleId: "persistent",
    statistic,
    period,
    total: bucketTotal,
    averages: { n: total, ...scaled },
    metricCounts,
    dimension,
    metric,
    buckets,
    brackets: buckets.map((bucket) => ({
      bracket_key: bracketFor(bucket.lo).key,
      n: bucket.n,
      sum: bucket.sum,
    })),
    histogram: [],
    bounds: { min: 0, max: dimension === "hours" ? 5000 : 1000 },
  };
}

const FAKE_ACHIEVEMENTS = [
  { id: "kappa-collector", name: "Kappa Collector", pct: 4.2, rarity: "mythic", hours: 2410 },
  { id: "shooter-born", name: "Shooter Born in Heaven", pct: 18.7, rarity: "rare", hours: 1180 },
  { id: "punisher", name: "Punisher", pct: 31.5, rarity: "common", hours: 640 },
  { id: "test-drive", name: "Test Drive", pct: 12.9, rarity: "rare", hours: 1520 },
  { id: "huntsman", name: "Huntsman", pct: 44.6, rarity: "common", hours: 410 },
  { id: "gunsmith", name: "Gunsmith", pct: 27.3, rarity: "common", hours: 830 },
  { id: "skiers-debt", name: "Skier's Debt", pct: 9.8, rarity: "rare", hours: 1870 },
  { id: "therapists-care", name: "Therapist's Care", pct: 52.1, rarity: "common", hours: 290 },
];

export function fakeAverageAchievements(): Record<string, unknown> {
  const rand = mulberry32(2026);
  return {
    total: FAKE_N,
    achievements: FAKE_ACHIEVEMENTS.map((ach) => {
      const owners = Math.round((FAKE_N * ach.pct) / 100);
      return {
        id: ach.id,
        name: ach.name,
        nameRu: ach.name,
        description: "Local dev placeholder achievement.",
        descriptionRu: "Локальная заглушка достижения для разработки.",
        imageUrl: null,
        side: "both",
        rarity: ach.rarity,
        owners,
        samplePct: ach.pct,
        officialPct: +(ach.pct * (0.9 + rand() * 0.2)).toFixed(1),
        meanHours: ach.hours,
        stdHours: Math.round(ach.hours * 0.4),
        earlyHours: Math.round(ach.hours * 0.3),
        unlockHours: Math.round(ach.hours * 0.55),
      };
    }),
  };
}

function fakeSeries(
  kind: ProgressionKind,
  points: number,
  startRaids: number,
  endRaids: number,
  valueAt: (t: number) => number,
): SeasonalAverageSeries {
  const rand = mulberry32(kind === "cumulative" ? 11 : kind === "tempo" ? 22 : 33);
  const overall: ProgressionPoint[] = [];
  for (let i = 0; i < points; i += 1) {
    const t = points === 1 ? 1 : i / (points - 1);
    const pmcRaids = Math.round(startRaids + (endRaids - startRaids) * t);
    overall.push({
      pointId: `local-fake-${kind}-${i}`,
      date: new Date(Date.now() - (points - 1 - i) * 86400000).toISOString().slice(0, 10),
      observedAt: Date.now() - (points - 1 - i) * 86400000,
      pmcRaids,
      level: Math.min(79, Math.round(6 + t * 52)),
      raidMin: i === 0 ? 0 : Math.round(startRaids + ((endRaids - startRaids) * (i - 1)) / (points - 1)),
      raidMax: pmcRaids,
      value: +(valueAt(t) * (1 + (rand() - 0.5) * 0.06)).toFixed(1),
      seriesId: null,
      p25: null,
      p75: null,
      n: FAKE_N,
      sampleN: FAKE_N,
      preliminary: false,
      confidence: 0.92,
    });
  }
  return { kind, overall, n: FAKE_N, confidence: 0.92, freshnessAt: Date.now() };
}

export function fakeProgressionAverage(mode: "regular" | "pve"): ProgressionAverageResponse {
  return {
    mode,
    cycleId: "persistent",
    axis: "pmc_raids",
    series: {
      cumulative: fakeSeries("cumulative", 40, 0, 520, (t) => 4000 + t * 620000),
      tempo: fakeSeries("tempo", 40, 0, 520, (t) => 900 + Math.sin(t * 9) * 260 + t * 500),
      form: fakeSeries("form", 30, 20, 520, (t) => 46 + Math.sin(t * 7) * 9),
    },
  };
}
