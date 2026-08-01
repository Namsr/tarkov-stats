import type { GameMode } from "@/types/seasonal";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { recordRequestEvent } from "../admin/request-events.ts";

type Mode = GameMode;
type Outcome = "success" | "error" | "invalid" | "not_found" | "rate_limited" | "unavailable";
type Source = "upstream" | "cache" | "stored";
type Cache = "hit" | "miss" | "bypass";
type Storage = "sqlite" | "unavailable";
type Memo = "hit" | "miss";

type TimingInput = {
  totalMs?: number;
  profileMs?: number;
  seasonalMs?: number;
  levelsMs?: number;
  parseMs?: number;
  storeOpenMs?: number;
  storeReadMs?: number;
  storeWriteMs?: number;
  averagesMs?: number;
  bucketAggregateMs?: number;
  rangeBoundsMs?: number;
  cohortMs?: number;
  baselineMs?: number;
  metadataMs?: number;
};

export type RequestTimingInput = TimingInput & {
  operation: "player_profile" | "average" | "average_cohort" | "baseline" | "average_achievements";
  mode?: Mode;
  outcome: Outcome;
  status: number;
  force?: boolean;
  source?: Source;
  cache?: Cache;
  storage?: Storage;
  memo?: Memo;
};

type Options = {
  random?: () => number;
  logger?: (event: string) => void;
  now?: () => number;
  sampleRate?: number;
  nodeEnv?: string;
};

type RequestContext = {
  aid?: number;
  nickname?: string | null;
  host?: string | null;
  cycleId?: string | null;
};

const defaultNow = () => performance.now();

export function getObservabilitySampleRate(
  value: string | undefined = process.env.OBSERVABILITY_SAMPLE_RATE,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): number {
  const fallback = nodeEnv === "production" ? 0.05 : 0;
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function roundedMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function startTimingPhase<T>(now: () => number, run: () => Promise<T>) {
  const startedAt = now();
  const promise = run();
  const syncMs = roundedMs(now() - startedAt);
  let settled = false;
  let completedMs = syncMs;
  const tracked = promise.then(
    (value) => {
      completedMs = roundedMs(now() - startedAt);
      settled = true;
      return value;
    },
    (error) => {
      completedMs = roundedMs(now() - startedAt);
      settled = true;
      throw error;
    },
  );

  return {
    promise: tracked,
    isSettled: () => settled,
    durationMs: (synchronous: boolean) => synchronous ? syncMs : completedMs,
  };
}

export function createRequestTiming(options: Options = {}) {
  const now = options.now ?? defaultNow;
  const sampleRate = options.sampleRate ?? getObservabilitySampleRate(undefined, options.nodeEnv);
  const sampled = sampleRate > 0 && (sampleRate >= 1 || (options.random ?? Math.random)() < sampleRate);
  const startedAt = now();
  let finished = false;
  let context: RequestContext = {};

  return {
    now,
    setRequestContext(input: RequestContext) {
      context = { ...context, ...input };
    },
    elapsedMs(started: number) {
      return roundedMs(now() - started);
    },
    finish(input: RequestTimingInput) {
      if (finished) return;
      finished = true;
      const totalMs = roundedMs(input.totalMs ?? now() - startedAt);
      void recordRequestEvent({
        operation: input.operation,
        aid: context.aid,
        nickname: context.nickname,
        host: context.host,
        mode: input.mode,
        cycleId: context.cycleId,
        outcome: input.outcome,
        status: input.status,
        force: input.force,
        source: input.source,
        cache: input.cache,
        latencyMs: totalMs,
      });
      if (!sampled) return;
      const event = {
        event: "request_timing_v1",
        entry: "api",
        operation: input.operation,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        outcome: input.outcome,
        status: input.status,
        ...(input.force === undefined ? {} : { force: input.force }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.cache === undefined ? {} : { cache: input.cache }),
        ...(input.storage === undefined ? {} : { storage: input.storage }),
        ...(input.memo === undefined ? {} : { memo: input.memo }),
        total_ms: totalMs,
        ...(input.profileMs === undefined ? {} : { profile_ms: roundedMs(input.profileMs) }),
        ...(input.seasonalMs === undefined ? {} : { seasonal_ms: roundedMs(input.seasonalMs) }),
        ...(input.levelsMs === undefined ? {} : { levels_ms: roundedMs(input.levelsMs) }),
        ...(input.parseMs === undefined ? {} : { parse_ms: roundedMs(input.parseMs) }),
        ...(input.storeOpenMs === undefined ? {} : { store_open_ms: roundedMs(input.storeOpenMs) }),
        ...(input.storeReadMs === undefined ? {} : { store_read_ms: roundedMs(input.storeReadMs) }),
        ...(input.storeWriteMs === undefined ? {} : { store_write_ms: roundedMs(input.storeWriteMs) }),
        ...(input.averagesMs === undefined ? {} : { averages_ms: roundedMs(input.averagesMs) }),
        ...(input.bucketAggregateMs === undefined ? {} : { bucket_aggregate_ms: roundedMs(input.bucketAggregateMs) }),
        ...(input.rangeBoundsMs === undefined ? {} : { range_bounds_ms: roundedMs(input.rangeBoundsMs) }),
        ...(input.cohortMs === undefined ? {} : { cohort_ms: roundedMs(input.cohortMs) }),
        ...(input.baselineMs === undefined ? {} : { baseline_ms: roundedMs(input.baselineMs) }),
        ...(input.metadataMs === undefined ? {} : { metadata_ms: roundedMs(input.metadataMs) }),
      };
      try {
        (options.logger ?? console.log)(JSON.stringify(event));
      } catch {
        // Observability must not affect the response path.
      }
    },
  };
}
