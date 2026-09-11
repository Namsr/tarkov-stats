"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useFavorites } from "@/lib/favorites/context";
import { useI18n } from "@/lib/i18n/context";
import { loadPlayerProfileResponse, PlayerProfileResponseError } from "@/lib/client-profile-request";
import ProfileRadar from "@/components/ProfileRadar";
import type { ParsedPlayerStats } from "@/types/tarkov";
import type { ProfileComparisonStats } from "@/types/profile-view";
import type { AveragePeriod, AverageStatistic } from "@/lib/db";
import type { GameMode } from "@/types/seasonal";

type Dimension = "hours" | "pmc_raids";
type MetricKey =
  | "kd_ratio"
  | "pmc_kd_ratio"
  | "kills_per_raid"
  | "pmc_survival_rate"
  | "longest_win_streak"
  | "level";

interface CohortMetricObject {
  value: number | null;
  count: number;
}

type CohortMetric = number | null | CohortMetricObject;

interface CohortResponse {
  identity?: { aid?: number; mode?: GameMode; cycleId?: string };
  twoDimensional?: boolean;
  period?: AveragePeriod;
  statistic?: AverageStatistic;
  dimension?: Dimension;
  center?: number;
  targetN?: number;
  target?: number;
  percent?: number;
  n?: number;
  quality?: "sufficient" | "unavailable";
  reason?: string;
  bounds?: {
    min?: number;
    max?: number;
    lo?: number;
    hi?: number;
  };
  min?: number;
  max?: number;
  averages?: Partial<Record<MetricKey, CohortMetric>>;
  ranges?: {
    hours?: { min?: number; max?: number; percent?: number };
    pmcRaids?: { min?: number; max?: number; percent?: number };
    raids?: { min?: number; max?: number; percent?: number };
  };
  actualRanges?: {
    hours?: { min?: number; max?: number } | null;
    pmcRaids?: { min?: number; max?: number } | null;
    raids?: { min?: number; max?: number } | null;
  };
}

type ComparisonStats = ParsedPlayerStats | ProfileComparisonStats;

interface CohortRange {
  min: number;
  max: number;
  percent: number;
}

interface NormalizedCohort {
  requestId: string;
  dimension: Dimension;
  center: number;
  targetN: number;
  percent: number;
  n: number;
  quality: "sufficient" | "unavailable";
  reason: string;
  twoDimensional: boolean;
  hoursRange: CohortRange | null;
  raidsRange: CohortRange | null;
  averages: Record<MetricKey, { value: number | null; count: number }>;
}

interface Props {
  aid: number;
  stats: ComparisonStats;
  mode?: GameMode;
  cycleId?: string;
  demo?: boolean;
  nickname?: string;
}

interface MetricDefinition {
  key: MetricKey;
  labelKey: string;
  get: (stats: ComparisonStats) => number | null;
  decimals: number;
  suffix?: string;
}

const MIN_AXIS_SAMPLE = 20;
const METRICS: MetricDefinition[] = [
  { key: "kd_ratio", labelKey: "radar.metric.kd", get: (s) => s.kdRatio, decimals: 2 },
  { key: "pmc_kd_ratio", labelKey: "radar.metric.pmcKd", get: (s) => s.pmcKdRatio, decimals: 2 },
  {
    key: "kills_per_raid",
    labelKey: "radar.metric.killsPerRaid",
    get: (s) => s.killsPerRaid,
    decimals: 2,
  },
  {
    key: "pmc_survival_rate",
    labelKey: "radar.metric.pmcSurvival",
    get: (s) => s.pmcSurvivalRate,
    decimals: 1,
    suffix: "%",
  },
  {
    key: "longest_win_streak",
    labelKey: "radar.metric.winStreak",
    get: (s) => s.longestWinStreak,
    decimals: 0,
  },
  { key: "level", labelKey: "radar.metric.level", get: (s) => s.level, decimals: 0 },
];

const DEMO_AVERAGES: Record<MetricKey, number> = {
  kd_ratio: 4.1,
  pmc_kd_ratio: 1.55,
  kills_per_raid: 3.2,
  pmc_survival_rate: 47,
  longest_win_streak: 7,
  level: 35,
};

const DEMO_PLAYER: Record<MetricKey, number> = {
  kd_ratio: 6.4,
  pmc_kd_ratio: 2.35,
  kills_per_raid: 4.15,
  pmc_survival_rate: 61,
  longest_win_streak: 11,
  level: 44,
};

const DEMO_FAVORITE: Record<MetricKey, number> = {
  kd_ratio: 3.2,
  pmc_kd_ratio: 1.1,
  kills_per_raid: 2.65,
  pmc_survival_rate: 39,
  longest_win_streak: 16,
  level: 29,
};

function rangeFromInput(input: { min?: number; max?: number; percent?: number } | undefined, fallbackPercent: number): CohortRange | null {
  if (!input || !Number.isFinite(Number(input.min)) || !Number.isFinite(Number(input.max))) return null;
  return {
    min: Number(input.min),
    max: Number(input.max),
    percent: Number(input.percent ?? fallbackPercent),
  };
}

function normalizeResponse(
  input: CohortResponse,
  hoursCenter: number,
  raidsCenter: number,
  sourceAid: number,
  mode: GameMode,
  cycleId: string,
  statistic: AverageStatistic,
  period: AveragePeriod
): NormalizedCohort {
  const n = Number(input.n ?? 0);
  const averages = {} as NormalizedCohort["averages"];
  for (const metric of METRICS) {
    const raw = input.averages?.[metric.key];
    averages[metric.key] =
      typeof raw === "number"
        ? { value: Number.isFinite(raw) ? raw : null, count: n }
        : raw && typeof raw === "object"
          ? {
              value:
                typeof raw.value === "number" && Number.isFinite(raw.value)
                  ? raw.value
                  : null,
              count: Number(raw.count ?? 0),
            }
          : { value: null, count: 0 };
  }

  return {
    requestId: `${sourceAid}:${mode}:${cycleId}:${hoursCenter}:${raidsCenter}:${input.statistic ?? statistic}:${input.period ?? period}`,
    dimension: "hours",
    center: hoursCenter,
    targetN: Number(input.targetN ?? input.target ?? 20),
    percent: Number(input.percent ?? 30),
    n,
    quality: input.quality === "sufficient" ? "sufficient" : "unavailable",
    reason: input.reason ?? "insufficient",
    twoDimensional: input.twoDimensional === true || Boolean(input.ranges?.hours && (input.ranges.pmcRaids ?? input.ranges.raids)),
    hoursRange: rangeFromInput(
      input.actualRanges ? input.actualRanges.hours ?? undefined : input.ranges?.hours,
      Number(input.percent ?? 30),
    ),
    raidsRange: rangeFromInput(
      input.actualRanges
        ? input.actualRanges.pmcRaids ?? input.actualRanges.raids ?? undefined
        : input.ranges?.pmcRaids ?? input.ranges?.raids,
      Number(input.percent ?? 30),
    ),
    averages,
  };
}

function demoCohort(
  hoursCenter: number,
  raidsCenter: number,
  statistic: AverageStatistic,
  period: AveragePeriod
): NormalizedCohort {
  const percent = 15;
  return {
    requestId: `demo:${hoursCenter}:${raidsCenter}:${statistic}:${period}`,
    dimension: "hours",
    center: hoursCenter,
    targetN: 20,
    percent,
    n: 184,
    quality: "sufficient",
    reason: "",
    twoDimensional: true,
    hoursRange: {
      min: Math.floor(hoursCenter * (1 - percent / 100)),
      max: Math.ceil(hoursCenter * (1 + percent / 100)),
      percent,
    },
    raidsRange: {
      min: Math.floor(raidsCenter * (1 - percent / 100)),
      max: Math.ceil(raidsCenter * (1 + percent / 100)),
      percent,
    },
    averages: Object.fromEntries(
      METRICS.map((metric) => [metric.key, { value: DEMO_AVERAGES[metric.key], count: 184 }])
    ) as NormalizedCohort["averages"],
  };
}

function valuesFromStats(stats: ComparisonStats): Record<MetricKey, number | null> {
  return Object.fromEntries(
    METRICS.map((metric) => [metric.key, metric.get(stats)]),
  ) as Record<MetricKey, number | null>;
}

export default function PlayerRadarComparison({ aid, stats, mode = "regular", cycleId = "persistent", demo = false, nickname }: Props) {
  const { t } = useI18n();
  const favoriteHintId = useId();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const statistic: AverageStatistic =
    searchParams.get("statistic") === "median" ? "median" : "trimmed_mean";
  const urlPeriod: AveragePeriod =
    mode === "regular" && searchParams.get("period") === "90d" ? "90d" : "all";
  const [selectedPeriod, setSelectedPeriod] = useState<AveragePeriod>(urlPeriod);
  const period = mode === "regular" ? selectedPeriod : "all";
  const { authStatus, favorites } = useFavorites();
  const [remoteCohort, setRemoteCohort] = useState<NormalizedCohort | null>(null);
  const [cohortLoading, setCohortLoading] = useState(!demo);
  const [cohortError, setCohortError] = useState("");
  const [showFavorite, setShowFavorite] = useState(demo);
  const [selectedAid, setSelectedAid] = useState<number | null>(null);
  const [favoriteProfile, setFavoriteProfile] = useState<{
    requestId: string;
    stats: ComparisonStats;
  } | null>(null);
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");

  useEffect(() => setSelectedPeriod(urlPeriod), [urlPeriod]);

  // Similarity is intentionally two-dimensional in both modes. The values
  // below are only request identity hints for legacy handlers; the server
  // derives the trusted centers from aid and the verified profile snapshot.
  const hoursCenter = Number.isFinite(Number(stats.hoursPlayed)) ? Number(stats.hoursPlayed) : 0;
  const raidsCenter = Number.isFinite(Number(stats.pmcRaids)) ? Number(stats.pmcRaids) : 0;
  const cohortRequestId = `${aid}:${mode}:${cycleId}:${hoursCenter}:${raidsCenter}:${statistic}:${period}`;

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      aid: String(aid),
      cycle: cycleId,
      mode,
      statistic,
      period,
    });
    // Arena remains on the legacy endpoint; persistent PvE now uses the same
    // server-derived two-dimensional cohort as regular PvP.
    if (mode === "arena") {
      params.set("dimension", "hours");
      params.set("center", String(hoursCenter));
      params.set("excludeAid", String(aid));
    }
    setCohortLoading(true);
    setCohortError("");
    const endpoint = mode === "seasonal" ? "/api/seasonal/cohort" : "/api/average/cohort";
    fetch(`${endpoint}?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as CohortResponse;
        if (!response.ok) throw new Error(t("radar.error.cohort"));
        if (payload.identity && (
          (payload.identity.aid != null && payload.identity.aid !== aid) ||
          (payload.identity.mode != null && payload.identity.mode !== mode) ||
          (payload.identity.cycleId != null && payload.identity.cycleId !== cycleId)
        )) {
          throw new Error(t("radar.error.cohort"));
        }
        return normalizeResponse(payload, hoursCenter, raidsCenter, aid, mode, cycleId, statistic, period);
      })
      .then((payload) => {
        if (!controller.signal.aborted && payload.requestId === cohortRequestId) setRemoteCohort(payload);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setRemoteCohort(null);
        // Browser fetch errors are implementation details (for example,
        // "Failed to fetch"). Keep them behind the localized app message.
        setCohortError(t("radar.error.cohort"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCohortLoading(false);
      });
    return () => controller.abort();
  }, [aid, cohortRequestId, cycleId, demo, hoursCenter, mode, period, raidsCenter, statistic, t]);

  function changeStatistic(next: AverageStatistic) {
    if (next === statistic) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "median") params.set("statistic", next);
    else params.delete("statistic");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function changePeriod(next: AveragePeriod) {
    if (next === period) return;
    setSelectedPeriod(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "90d") params.set("period", next);
    else params.delete("period");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const eligibleFavorites = useMemo(
    () => favorites.filter((favorite) => favorite.aid !== aid),
    [aid, favorites]
  );
  const defaultFavoriteAid =
    eligibleFavorites.find((favorite) => favorite.isMain)?.aid ?? eligibleFavorites[0]?.aid ?? null;
  const effectiveFavoriteAid = eligibleFavorites.some((favorite) => favorite.aid === selectedAid)
    ? selectedAid
    : defaultFavoriteAid;
  const favoriteRequestId =
    effectiveFavoriteAid == null ? null : `${mode}:${cycleId}:${effectiveFavoriteAid}`;
  const favoriteStats =
    favoriteProfile?.requestId === favoriteRequestId ? favoriteProfile.stats : null;

  useEffect(() => {
    if (
      demo ||
      !showFavorite ||
      authStatus !== "authenticated" ||
      !effectiveFavoriteAid ||
      !favoriteRequestId
    ) {
      return;
    }
    let cancelled = false;
    setFavoriteLoading(true);
    setFavoriteError("");
    setFavoriteProfile(null);
    const favoriteParams = new URLSearchParams({
      aid: String(effectiveFavoriteAid),
      mode,
      cycle: cycleId,
    });
    loadPlayerProfileResponse<{
          identity?: { aid?: number; mode?: GameMode; cycleId?: string };
          stats?: ParsedPlayerStats;
          comparisonStats?: ProfileComparisonStats;
        }>(`/api/player/profile?${favoriteParams}`)
      .then(({ ok, body: payload }) => {
        const nextStats = payload.comparisonStats ?? payload.stats;
        const identityMatches = payload.identity?.aid === effectiveFavoriteAid
            && payload.identity.mode === mode
            && payload.identity.cycleId === cycleId;
        if (!ok || !nextStats || !identityMatches) {
          throw new Error(t("radar.error.favorite"));
        }
        return nextStats;
      })
      .then((payload) => {
        if (!cancelled) {
          setFavoriteProfile({ requestId: favoriteRequestId, stats: payload });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFavoriteError(error instanceof PlayerProfileResponseError
            ? t("radar.error.favorite")
            : error instanceof Error ? error.message : t("radar.error.favorite"));
        }
      })
      .finally(() => {
        if (!cancelled) setFavoriteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authStatus, cycleId, demo, effectiveFavoriteAid, favoriteRequestId, mode, showFavorite, t]);

  const cohort = demo
    ? demoCohort(hoursCenter, raidsCenter, statistic, period)
    : remoteCohort?.requestId === cohortRequestId
      ? remoteCohort
      : null;
  const playerStatsKnown = demo || mode !== "regular" || stats.pvpStatsKnown !== false;
  const favoriteStatsKnown = demo || mode !== "regular" || favoriteStats?.pvpStatsKnown !== false;
  const playerValues = demo ? DEMO_PLAYER : playerStatsKnown ? valuesFromStats(stats) : null;
  const favoriteValues = demo
    ? DEMO_FAVORITE
    : favoriteStats && favoriteStatsKnown
      ? valuesFromStats(favoriteStats)
      : null;

  const favoriteDisabledReason = demo ? "" : authStatus === "loading" ? t("radar.favorite.sessionLoading")
    : authStatus === "unauthenticated" ? t("radar.favorite.authRequired")
    : authStatus === "error" ? t("radar.favorite.authError")
    : eligibleFavorites.length === 0 ? t("radar.favorite.empty") : "";
  const favoriteDisabled = Boolean(favoriteDisabledReason);
  const useFavorite = showFavorite && !favoriteDisabled;
  const otherName = useFavorite
    ? demo ? t("radar.demoFavorite") : eligibleFavorites.find((favorite) => favorite.aid === effectiveFavoriteAid)?.nickname || t("radar.series.favorite")
    : t("radar.series.average");
  const rows = METRICS.map((metric, index) => {
    const average = cohort?.averages[metric.key];
    const baseline = cohort?.quality === "sufficient" && cohort.twoDimensional && average?.value != null && average.value > 0
      && average.count >= (metric.key === "pmc_survival_rate" ? 1 : MIN_AXIS_SAMPLE) ? average.value : null;
    return {
      key: metric.key, label: t(metric.labelKey),
      shortLabel: t(["radar.metric.kd", "radar.metric.pmcKd", "home.radarKills", "home.radarSurvival", "home.radarStreak", "metric.level"][index]),
      a: playerValues?.[metric.key] ?? null, b: useFavorite ? favoriteValues?.[metric.key] ?? null : baseline,
      baseline, digits: metric.decimals, percent: metric.suffix === "%",
    };
  });

  return <div className="profile-comparison" aria-busy={cohortLoading || (useFavorite && favoriteLoading) || undefined}>
    <h2 className="section-heading">{t("profile.section.comparison")}</h2>
    <div className="profile-comparison-controls">
      <div className="profile-segments" role="group" aria-label={t("home.compareWith")}>
        <button type="button" aria-pressed={!useFavorite} onClick={() => setShowFavorite(false)}>{t("home.averagePlayer")}</button>
        <span className={favoriteDisabled ? "disabled-control-hint" : undefined} tabIndex={favoriteDisabled ? 0 : undefined} role={favoriteDisabled ? "group" : undefined} aria-label={favoriteDisabled ? t("home.anotherPlayer") : undefined} aria-describedby={favoriteDisabled ? favoriteHintId : undefined}>
          <button type="button" aria-pressed={useFavorite} disabled={favoriteDisabled} aria-describedby={favoriteDisabled ? favoriteHintId : undefined} onClick={() => setShowFavorite(true)}>{t("home.anotherPlayer")}</button>
          {favoriteDisabled && <span id={favoriteHintId} role="tooltip" className="disabled-control-tooltip">{favoriteDisabledReason}</span>}
        </span>
      </div>
      {useFavorite && <label className="profile-select"><span className="sr-only">{t("radar.favorite.select")}</span><select value={demo ? "demo" : effectiveFavoriteAid ?? ""} onChange={(event) => setSelectedAid(Number(event.target.value))}>
        {demo ? <option value="demo">{t("radar.demoFavorite")}</option> : eligibleFavorites.map((favorite) => <option key={favorite.aid} value={favorite.aid}>{favorite.nickname || `#${favorite.aid}`}</option>)}
      </select></label>}
    </div>
    <div className="profile-comparison-method">
      <label className="profile-select"><span className="sr-only">{t("average.statistic.label")}</span><select value={statistic} onChange={(event) => changeStatistic(event.target.value as AverageStatistic)}><option value="trimmed_mean">{t("average.statistic.trimmedMean")}</option><option value="median">{t("average.statistic.median")}</option></select></label>
      {mode === "regular" && <label className="profile-select"><span className="sr-only">{t("average.period.label")}</span><select value={period} onChange={(event) => changePeriod(event.target.value as AveragePeriod)}><option value="all">{t("average.period.all")}</option><option value="90d">{t("average.period.last90Days")}</option></select></label>}
    </div>
    {(cohortLoading || cohortError || (useFavorite && (favoriteLoading || favoriteError))) && <p className="profile-chart-notice" role="status">{cohortError || (useFavorite && favoriteError) || t("common.loading")}</p>}
    {!playerStatsKnown && <p className="profile-chart-notice" role="status">{t("radar.incompletePvp.player")}</p>}
    {useFavorite && favoriteStats && !favoriteStatsKnown && <p className="profile-chart-notice" role="status">{t("radar.incompletePvp.favorite")}</p>}
    <ProfileRadar key={`${aid}:${mode}:${cycleId}:${statistic}:${period}:${useFavorite}:${effectiveFavoriteAid}`} metrics={rows} playerName={nickname || ("nickname" in stats ? stats.nickname : t("radar.series.player"))} otherName={otherName} />
  </div>;
}
