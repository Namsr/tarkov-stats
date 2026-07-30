import { loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { d1Rows, getSeasonalD1 } from "@/lib/seasonal/d1";
import {
  buildSeasonalAverageSeries,
  LIFETIME_BAND_DISTRIBUTION_SQL,
  lifetimeBandDistribution,
  progressionDailySql,
  SEASONAL_POPULATION_SQL,
  seasonalPopulationArgs,
  seasonalPopulationSummary,
  type DailyRow,
  type LifetimeBandCountRow,
  type SeasonalPopulationRow,
} from "@/lib/seasonal/progression";
import { initializeSeasonalSchema, upsertSqliteSeasonCycle } from "@/lib/seasonal/storage";
import { upsertD1SeasonCycle } from "@/lib/seasonal/storage-d1";
import type {
  ProgressionKind,
  SeasonalAverageResponse,
} from "@/types/seasonal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let database: any = null;

const KINDS = ["cumulative", "tempo", "form"] as const satisfies readonly ProgressionKind[];

export async function getSeasonalAverageQuery(): Promise<
  ((cycleId: string, now?: number) => Promise<SeasonalAverageResponse | null>) | null
> {
  try {
    const d1 = await getSeasonalD1();
    const configuredCycle = loadSeasonalCycleConfig();
    if (d1) {
      if (configuredCycle) await upsertD1SeasonCycle(d1, configuredCycle);
      return async (cycleId, now = Date.now()) => {
        const cycle = await d1.prepare(
          "SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?"
        ).bind(cycleId).first() as { starts_at: number } | null;
        if (!cycle) return null;
        const [population, distributionResult, ...dailyResults] = await Promise.all([
          d1.prepare(SEASONAL_POPULATION_SQL).bind(...seasonalPopulationArgs(cycleId, now)).first() as Promise<SeasonalPopulationRow | null>,
          d1.prepare(LIFETIME_BAND_DISTRIBUTION_SQL).bind("seasonal", cycleId).all(),
          ...KINDS.map((kind) => d1.prepare(progressionDailySql(kind))
            .bind("seasonal", cycleId, "seasonal", cycleId, -1).all()),
        ]);
        const distribution = lifetimeBandDistribution(
          d1Rows(distributionResult) as unknown as LifetimeBandCountRow[]
        );
        const series = Object.fromEntries(KINDS.map((kind, index) => [
          kind,
          buildSeasonalAverageSeries(
            d1Rows(dailyResults[index]) as unknown as DailyRow[],
            Number(cycle.starts_at),
            kind,
            distribution,
          ),
        ])) as SeasonalAverageResponse["series"];
        return {
          mode: "seasonal",
          cycleId,
          population: seasonalPopulationSummary(population, distribution),
          series,
        };
      };
    }

    if (!database) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      database = new sqlite.DatabaseSync(
        process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db"
      );
      initializeSeasonalSchema(database);
    }
    if (configuredCycle) upsertSqliteSeasonCycle(database, configuredCycle);
    return async (cycleId, now = Date.now()) => {
      const cycle = database.prepare(
        "SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?"
      ).get(cycleId) as { starts_at: number } | undefined;
      if (!cycle) return null;
      const population = database.prepare(SEASONAL_POPULATION_SQL)
        .get(...seasonalPopulationArgs(cycleId, now)) as SeasonalPopulationRow | undefined;
      const distribution = lifetimeBandDistribution(
        database.prepare(LIFETIME_BAND_DISTRIBUTION_SQL).all("seasonal", cycleId) as LifetimeBandCountRow[]
      );
      const series = Object.fromEntries(KINDS.map((kind) => [
        kind,
        buildSeasonalAverageSeries(
          database.prepare(progressionDailySql(kind))
            .all("seasonal", cycleId, "seasonal", cycleId, -1) as DailyRow[],
          Number(cycle.starts_at),
          kind,
          distribution,
        ),
      ])) as SeasonalAverageResponse["series"];
      return {
        mode: "seasonal",
        cycleId,
        population: seasonalPopulationSummary(population, distribution),
        series,
      };
    };
  } catch (error) {
    console.warn("seasonal average query unavailable: " + (error as Error).message);
    return null;
  }
}
