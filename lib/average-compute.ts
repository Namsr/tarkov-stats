import { getStore, type AveragePeriod, type AverageStatistic, type BucketAgg, type CrossSectionMode, type RangeDimension } from "@/lib/db";
import { buildNumericHistogram } from "@/lib/histogram";
import { DEFAULT_Y, resolveY } from "@/lib/metrics";

function legacyBrackets(buckets: BucketAgg[]) {
  return buckets.map((bucket) => ({
    bracket_key: bucket.hi == null ? `${bucket.lo}+` : `${bucket.lo}-${bucket.hi}`,
    n: bucket.n,
    sum: bucket.sum,
  }));
}

export interface AverageComputePhases {
  averagesMs?: number;
  bucketAggregateMs?: number;
  rangeBoundsMs?: number;
}

async function timedPhase<T>(phases: AverageComputePhases | undefined, key: keyof AverageComputePhases, load: () => Promise<T>): Promise<T> {
  if (!phases) return load();
  const started = performance.now();
  try {
    return await load();
  } finally {
    phases[key] = Math.max(0, Math.round(performance.now() - started));
  }
}

export async function computeAverage(
  mode: CrossSectionMode,
  dimension: RangeDimension,
  metricKey: string,
  maxBins: number,
  statistic: AverageStatistic,
  period: AveragePeriod,
  min: number | null,
  max: number | null,
  maxInclusive: boolean,
  phases?: AverageComputePhases,
) {
  const metric = resolveY(metricKey);
  const store = await getStore(mode);
  if (!store) {
    return {
      storage: "unavailable" as const,
      body: {
        mode,
        cycleId: "persistent",
        total: 0,
        averages: null,
        metricCounts: {},
        brackets: [],
        buckets: [],
        histogram: [],
        bounds: { min: 0, max: dimension === "hours" ? 5000 : 1000 },
        dimension,
        metric: metric.key || DEFAULT_Y,
        statistic,
        period,
      },
    };
  }

  const [averageResult, bucketResult, boundsResult] = await Promise.all([
    timedPhase(phases, "averagesMs", () => store.averages({ dimension, min, max, maxInclusive }, statistic, period)),
    timedPhase(phases, "bucketAggregateMs", () => store.bucketAggregate(dimension, metric.agg === "avg" ? metric.column! : null, period, statistic)),
    timedPhase(phases, "rangeBoundsMs", () => store.rangeBounds(dimension, period)),
  ]);
  const total = bucketResult.reduce((sum, bucket) => sum + bucket.n, 0);
  const { metricCounts, ...averageValues } = averageResult ?? { metricCounts: {} };
  const histogram = buildNumericHistogram(bucketResult, maxBins).map((bin) => ({
    ...bin,
    avg: metric.agg === "avg" && bin.n > 0 ? bin.sum / bin.n : null,
  }));

  return {
    storage: "sqlite" as const,
    body: {
      mode,
      cycleId: "persistent",
      total,
      averages: averageResult ? averageValues : null,
      metricCounts,
      brackets: legacyBrackets(bucketResult),
      buckets: bucketResult,
      histogram,
      bounds: boundsResult,
      dimension,
      metric: metric.key,
      statistic,
      period,
    },
  };
}
