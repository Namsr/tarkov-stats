import { getStore, type AveragePeriod, type AverageStatistic, type BucketAgg } from "@/lib/db";
import { AVERAGE_OVERLAY_METRICS } from "@/lib/metrics";
import { computeSeasonalMetricSeries } from "@/lib/seasonal/average-db";

export interface AverageMetricSeriesInput {
  mode: "regular" | "pve" | "seasonal";
  cycleId: string;
  statistic: AverageStatistic;
  period: AveragePeriod;
}

export interface AverageMetricSeriesResponse extends AverageMetricSeriesInput {
  series: Record<(typeof AVERAGE_OVERLAY_METRICS)[number], BucketAgg[]>;
}

/** Runs only in the existing computation child, using the same bucket contracts. */
export async function computeAverageMetricSeries(input: AverageMetricSeriesInput): Promise<AverageMetricSeriesResponse | null> {
  if (input.mode === "seasonal") return computeSeasonalMetricSeries(input.cycleId, input.period, input.statistic);
  const store = await getStore(input.mode);
  if (!store) return null;
  const series = {} as AverageMetricSeriesResponse["series"];
  for (const metric of AVERAGE_OVERLAY_METRICS) {
    series[metric] = await store.bucketAggregate("pmc_raids", metric, input.period, input.statistic);
  }
  return { ...input, series };
}
