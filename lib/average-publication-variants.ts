// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { seasonalPublicationScope, standardArenaVariant, standardAverageVariant, type AveragePublicationScope } from "./average-publication.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { ARENA_MODE_KEYS, type ArenaModeKey } from "../types/arena.ts";
import type { AveragePeriod, AverageStatistic } from "./db";

export const STANDARD_AVERAGE_STATISTICS = ["trimmed_mean", "median"] as const satisfies readonly AverageStatistic[];
export const STANDARD_AVERAGE_PERIODS = ["all", "90d"] as const satisfies readonly AveragePeriod[];

export type AveragePublicationVariant =
  | { scope: "regular" | "pve" | `seasonal:${string}`; variant: string; statistic: AverageStatistic; period: AveragePeriod }
  | { scope: "arena"; variant: string; statistic: AverageStatistic; arenaMode: ArenaModeKey };

export function standardAveragePublicationVariants(cycleId: string | null): AveragePublicationVariant[] {
  const variants: AveragePublicationVariant[] = [];
  const regularScopes: AveragePublicationScope[] = ["regular", "pve"];
  if (cycleId) regularScopes.push(seasonalPublicationScope(cycleId));
  for (const scope of regularScopes) {
    for (const statistic of STANDARD_AVERAGE_STATISTICS) {
      for (const period of STANDARD_AVERAGE_PERIODS) {
        variants.push({ scope: scope as "regular" | "pve" | `seasonal:${string}`, variant: standardAverageVariant(statistic, period), statistic, period });
      }
    }
  }
  for (const statistic of STANDARD_AVERAGE_STATISTICS) {
    for (const arenaMode of ARENA_MODE_KEYS) {
      variants.push({ scope: "arena", variant: standardArenaVariant(arenaMode, statistic), statistic, arenaMode });
    }
  }
  return variants;
}
