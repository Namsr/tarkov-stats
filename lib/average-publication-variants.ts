import type { AveragePeriod, AverageStatistic } from "./db";

export const STANDARD_AVERAGE_STATISTICS = ["trimmed_mean", "median"] as const satisfies readonly AverageStatistic[];
export const STANDARD_AVERAGE_PERIODS = ["all", "90d"] as const satisfies readonly AveragePeriod[];
