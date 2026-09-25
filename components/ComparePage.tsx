"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ComparisonTable, { type ComparisonRow } from "@/components/ComparisonTable";
import PercentileBadge from "@/components/PercentileBadge";
import SearchBar from "@/components/SearchBar";
import { loadAverageJson } from "@/lib/client-average-request";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import { useI18n } from "@/lib/i18n/context";
import type { ProfileComparisonStats } from "@/types/profile-view";
import type { GameMode } from "@/types/seasonal";
import type { ParsedPlayerStats } from "@/types/tarkov";

const METRIC_KEYS = [
  "kd_ratio",
  "pmc_kd_ratio",
  "kills_per_raid",
  "pmc_survival_rate",
  "longest_win_streak",
  "level",
] as const;

type CompareMetricKey = (typeof METRIC_KEYS)[number];
type CompareStats = ParsedPlayerStats | ProfileComparisonStats;

export interface PlayerProfileResponse {
  profile?: { info?: { nickname?: string } | null } | null;
  stats?: ParsedPlayerStats | null;
  comparisonStats?: ProfileComparisonStats | null;
  identity?: { aid?: number; mode?: GameMode; cycleId?: string };
  viewModel?: { identity?: { nickname?: string } | null } | null;
  code?: string;
  error?: string;
}

export interface ComparePercentileMetric {
  percentile: number | null;
  count: number;
  below: number;
  equal: number;
}

interface CompareRange {
  min: number;
  max: number;
}

export interface CompareCohortResponse {
  identity?: { aid?: number; mode?: GameMode; cycleId?: string };
  n?: number;
  strategy?: "matched" | "population";
  quality?: "sufficient" | "unavailable";
  reason?: string | null;
  percent?: number;
  percentiles: Record<CompareMetricKey, ComparePercentileMetric>;
  averages?: Partial<Record<CompareMetricKey, { value: number | null; count: number } | number | null>>;
  actualRanges?: {
    hours?: CompareRange | null;
    pmcRaids?: CompareRange | null;
    raids?: CompareRange | null;
  } | null;
}

interface MetricDefinition {
  key: CompareMetricKey;
  labelKey: string;
  get: (stats: CompareStats) => number | null;
  decimals: number;
  suffix?: string;
}

const METRICS: readonly MetricDefinition[] = [
  { key: "kd_ratio", labelKey: "radar.metric.kd", get: (stats) => stats.kdRatio, decimals: 2 },
  { key: "pmc_kd_ratio", labelKey: "radar.metric.pmcKd", get: (stats) => stats.pmcKdRatio, decimals: 2 },
  { key: "kills_per_raid", labelKey: "radar.metric.killsPerRaid", get: (stats) => stats.killsPerRaid, decimals: 2 },
  {
    key: "pmc_survival_rate",
    labelKey: "radar.metric.pmcSurvival",
    get: (stats) => stats.pmcSurvivalRate,
    decimals: 1,
    suffix: "%",
  },
  { key: "longest_win_streak", labelKey: "radar.metric.winStreak", get: (stats) => stats.longestWinStreak, decimals: 0 },
  { key: "level", labelKey: "radar.metric.level", get: (stats) => stats.level, decimals: 0 },
];

interface ProfileLoadState {
  aid: number | null;
  data: PlayerProfileResponse | null;
  loading: boolean;
  error: string;
  missing: boolean;
}

interface CohortLoadState {
  aid: number | null;
  data: CompareCohortResponse | null;
  loading: boolean;
  error: string;
}

type RankedMetric = { key: CompareMetricKey; label: string; percentile: number };

function parseAid(value: string | null): number | null {
  if (!value) return null;
  const aid = Number(value);
  return Number.isSafeInteger(aid) && aid > 0 ? aid : null;
}

function profileRequestUrl(aid: number): string {
  return `/api/player/profile?${new URLSearchParams({ aid: String(aid), mode: "regular" })}`;
}

function cohortRequestUrl(aid: number): string {
  return `/api/average/cohort?${new URLSearchParams({
    aid: String(aid),
    mode: "regular",
    statistic: "median",
    period: "90d",
  })}`;
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePercentile(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function profileStats(response: PlayerProfileResponse | null): CompareStats | null {
  if (!response) return null;
  return response.stats ?? response.comparisonStats ?? null;
}

function profileName(response: PlayerProfileResponse, aid: number): string {
  return response.stats?.nickname?.trim() ||
    response.profile?.info?.nickname?.trim() ||
    response.viewModel?.identity?.nickname?.trim() ||
    `#${aid}`;
}

function identityMatches(response: PlayerProfileResponse, aid: number): boolean {
  return response.identity?.aid === aid && response.identity.mode === "regular" && response.identity.cycleId === "persistent";
}

function cohortIdentityMatches(response: CompareCohortResponse, aid: number): boolean {
  return response.identity?.aid === aid && response.identity.mode === "regular" && response.identity.cycleId === "persistent";
}

function valuesFromStats(stats: CompareStats | null): Record<CompareMetricKey, number | null> {
  if (!stats) {
    return Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as Record<CompareMetricKey, number | null>;
  }
  const pmcStatsKnown = stats.pvpStatsKnown !== false;
  return {
    kd_ratio: finiteMetric(stats.kdRatio),
    pmc_kd_ratio: pmcStatsKnown ? finiteMetric(stats.pmcKdRatio) : null,
    kills_per_raid: finiteMetric(stats.killsPerRaid),
    pmc_survival_rate: pmcStatsKnown ? finiteMetric(stats.pmcSurvivalRate) : null,
    longest_win_streak: finiteMetric(stats.longestWinStreak),
    level: finiteMetric(stats.level),
  };
}

function benchmarkFor(cohort: CompareCohortResponse | null, key: CompareMetricKey): number | null {
  const value = cohort?.averages?.[key];
  if (typeof value === "number") return finiteMetric(value);
  if (!value || typeof value !== "object" || value.count <= 0) return null;
  return finiteMetric(value.value);
}

function percentileFor(cohort: CompareCohortResponse | null, key: CompareMetricKey): ComparePercentileMetric | null {
  const value = cohort?.percentiles?.[key];
  return value && typeof value === "object" ? value : null;
}

function medianPercentile(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function formatPercentile(value: number | null, lang: string): string {
  return value == null ? "—" : `P${value.toLocaleString(lang, { maximumFractionDigits: 1 })}`;
}

function formatRange(range: CompareRange | null | undefined, lang: string, decimals = 0): string {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "—";
  return `${range.min.toLocaleString(lang, { maximumFractionDigits: decimals })}–${range.max.toLocaleString(lang, { maximumFractionDigits: decimals })}`;
}

function RankedMetricList({ title, items }: { title: string; items: readonly RankedMetric[] }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--card-border)] bg-[var(--input-bg)] p-4">
      <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--muted)]">{title}</h3>
      <div className="mt-3 grid gap-3">
        {items.map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 text-[var(--muted-strong)]">{item.label}</span>
            <PercentileBadge percentile={item.percentile} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ComparePage() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const primaryAid = parseAid(searchParams.get("aid"));
  const secondaryAid = parseAid(searchParams.get("vs"));
  const [primaryState, setPrimaryState] = useState<ProfileLoadState>(() => ({
    aid: primaryAid,
    data: null,
    loading: primaryAid !== null,
    error: "",
    missing: false,
  }));
  const [secondaryState, setSecondaryState] = useState<ProfileLoadState>(() => ({
    aid: secondaryAid,
    data: null,
    loading: secondaryAid !== null,
    error: "",
    missing: false,
  }));
  const [cohortState, setCohortState] = useState<CohortLoadState>(() => ({
    aid: primaryAid,
    data: null,
    loading: primaryAid !== null,
    error: "",
  }));

  useEffect(() => {
    if (primaryAid === null) {
      setPrimaryState({ aid: null, data: null, loading: false, error: "", missing: false });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setPrimaryState({ aid: primaryAid, data: null, loading: true, error: "", missing: false });
    loadPlayerProfileResponse<PlayerProfileResponse>(profileRequestUrl(primaryAid), { signal: controller.signal })
      .then(({ ok, status, body }) => {
        if (cancelled || controller.signal.aborted) return;
        if (!ok) {
          const missing = status === 404 || body?.code === "mode_profile_unavailable" || body?.code === "profile_unavailable";
          setPrimaryState({
            aid: primaryAid,
            data: null,
            loading: false,
            error: t(missing ? "compare.profileMissing" : "compare.profileLoadError"),
            missing,
          });
          return;
        }
        if (!identityMatches(body, primaryAid) || !profileStats(body)) {
          setPrimaryState({
            aid: primaryAid,
            data: null,
            loading: false,
            error: t("compare.profileLoadError"),
            missing: false,
          });
          return;
        }
        setPrimaryState({ aid: primaryAid, data: body, loading: false, error: "", missing: false });
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) {
          setPrimaryState({
            aid: primaryAid,
            data: null,
            loading: false,
            error: t("compare.profileLoadError"),
            missing: false,
          });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [primaryAid, t]);

  useEffect(() => {
    if (secondaryAid === null) {
      setSecondaryState({ aid: null, data: null, loading: false, error: "", missing: false });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setSecondaryState({ aid: secondaryAid, data: null, loading: true, error: "", missing: false });
    loadPlayerProfileResponse<PlayerProfileResponse>(profileRequestUrl(secondaryAid), { signal: controller.signal })
      .then(({ ok, status, body }) => {
        if (cancelled || controller.signal.aborted) return;
        if (!ok) {
          const missing = status === 404 || body?.code === "mode_profile_unavailable" || body?.code === "profile_unavailable";
          setSecondaryState({
            aid: secondaryAid,
            data: null,
            loading: false,
            error: t(missing ? "compare.profileMissing" : "compare.profileLoadError"),
            missing,
          });
          return;
        }
        if (!identityMatches(body, secondaryAid) || !profileStats(body)) {
          setSecondaryState({
            aid: secondaryAid,
            data: null,
            loading: false,
            error: t("compare.profileLoadError"),
            missing: false,
          });
          return;
        }
        setSecondaryState({ aid: secondaryAid, data: body, loading: false, error: "", missing: false });
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) {
          setSecondaryState({
            aid: secondaryAid,
            data: null,
            loading: false,
            error: t("compare.profileLoadError"),
            missing: false,
          });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [secondaryAid, t]);

  useEffect(() => {
    if (primaryAid === null) {
      setCohortState({ aid: null, data: null, loading: false, error: "" });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setCohortState({ aid: primaryAid, data: null, loading: true, error: "" });
    loadAverageJson<CompareCohortResponse>(cohortRequestUrl(primaryAid), { signal: controller.signal })
      .then((body) => {
        if (cancelled || controller.signal.aborted) return;
        if (!cohortIdentityMatches(body, primaryAid)) throw new Error("cohort identity mismatch");
        setCohortState({ aid: primaryAid, data: body, loading: false, error: "" });
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) {
          setCohortState({ aid: primaryAid, data: null, loading: false, error: t("compare.cohortError") });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [primaryAid, t]);

  const primaryCurrent = primaryState.aid === primaryAid ? primaryState : null;
  const secondaryCurrent = secondaryState.aid === secondaryAid ? secondaryState : null;
  const cohortCurrent = cohortState.aid === primaryAid ? cohortState : null;
  const primaryProfile = primaryCurrent?.data ?? null;
  const secondaryProfile = secondaryCurrent?.data ?? null;
  const primaryStats = profileStats(primaryProfile);
  const secondaryStats = profileStats(secondaryProfile);
  const primaryKnown = primaryStats !== null && primaryStats.pvpStatsKnown !== false;
  const secondaryKnown = secondaryStats !== null && secondaryStats.pvpStatsKnown !== false;
  const primaryValues = valuesFromStats(primaryStats);
  const secondaryValues = valuesFromStats(secondaryStats);
  const cohort = cohortCurrent?.data ?? null;
  const ranked: RankedMetric[] = METRICS.flatMap((metric) => {
    if (primaryValues[metric.key] === null) return [];
    const percentile = finitePercentile(percentileFor(cohort, metric.key)?.percentile);
    return percentile === null ? [] : [{ key: metric.key, label: t(metric.labelKey), percentile }];
  });
  const strengths = [...ranked].sort((left, right) => right.percentile - left.percentile).slice(0, 2);
  const weaknesses = [...ranked].sort((left, right) => left.percentile - right.percentile).slice(0, 2);
  const median = medianPercentile(ranked.map((item) => item.percentile));
  const primaryName = primaryProfile && primaryAid !== null
    ? profileName(primaryProfile, primaryAid)
    : primaryAid ? `#${primaryAid}` : "";
  const secondaryName = secondaryProfile && secondaryAid !== null
    ? profileName(secondaryProfile, secondaryAid)
    : secondaryAid ? `#${secondaryAid}` : "";
  const cohortLoading = primaryAid !== null && (cohortCurrent === null || cohortCurrent.loading);
  const cohortError = cohortCurrent?.error ?? "";
  const cohortUnavailable = cohort?.quality === "unavailable";
  const cohortSize = finiteMetric(cohort?.n);
  const actualHours = cohort?.actualRanges?.hours ?? null;
  const actualPmcRaids = cohort?.actualRanges?.pmcRaids ?? cohort?.actualRanges?.raids ?? null;
  const cohortWindow = finitePercentile(cohort?.percent);
  const strategyLabel = cohort?.strategy === "population"
    ? t("compare.cohortPopulationFallback")
    : cohort?.strategy === "matched"
      ? t("compare.cohortMatched")
      : null;
  const rows: ComparisonRow[] = METRICS.map((metric) => ({
    key: metric.key,
    label: t(metric.labelKey),
    valueA: primaryValues[metric.key],
    valueB: secondaryValues[metric.key],
    benchmark: benchmarkFor(cohort, metric.key),
    percentile: primaryValues[metric.key] === null ? null : finitePercentile(percentileFor(cohort, metric.key)?.percentile),
    decimals: metric.decimals,
    suffix: metric.suffix,
  }));

  function updateSelection(slot: "primary" | "secondary", aid: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(slot === "primary" ? "aid" : "vs", String(aid));
    const query = params.toString();
    router.replace(`/compare${query ? `?${query}` : ""}`, { scroll: false });
  }

  function profileCard(label: string, aid: number | null, current: ProfileLoadState | null) {
    const loading = aid !== null && (current === null || current.loading);
    const data = current?.data ?? null;
    const name = data && aid !== null ? profileName(data, aid) : aid !== null ? `#${aid}` : "";
    return (
      <article className="surface min-w-0 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="section-kicker">{label}</p>
            <h2 className="mt-2 break-words text-xl font-bold text-[var(--foreground)]">{name || t("compare.choosePlayer")}</h2>
            {aid !== null && <p className="mt-1 text-sm text-[var(--muted)]">#{aid}</p>}
          </div>
          {aid !== null && (
            <Link prefetch={false} href={`/player/regular/${aid}`} className="ghost-button">
              {t("compare.fullProfile")}
            </Link>
          )}
        </div>
        {aid === null && <p className="mt-4 text-sm text-[var(--muted)]">{t("compare.choosePlayer")}</p>}
        {loading && <p className="mt-4 text-sm text-[var(--muted)]" role="status">{t("common.loading")}</p>}
        {!loading && current?.error && <p className="mt-4 text-sm text-[var(--danger)]" role="alert">{current.error}</p>}
      </article>
    );
  }

  return (
    <main className="page-frame">
      <header>
        <p className="page-kicker">{t("compare.pageKicker")}</p>
        <h1 className="page-title">{t("compare.pageTitle")}</h1>
        <p className="mt-4 max-w-3xl text-[var(--muted)]">{t("compare.pageDescription")}</p>
      </header>

      <section className="mt-8 grid gap-5 md:grid-cols-2" aria-label={t("compare.searchPlayers")}>
        <div className="min-w-0">
          <h2 className="section-heading">{t("compare.primaryPlayer")}</h2>
          <SearchBar fixedMode="regular" onSelect={(aid) => updateSelection("primary", aid)} />
        </div>
        <div className="min-w-0">
          <h2 className="section-heading">{t("compare.secondaryPlayer")}</h2>
          <SearchBar fixedMode="regular" onSelect={(aid) => updateSelection("secondary", aid)} />
        </div>
      </section>

      <section className="mt-6 grid gap-5 md:grid-cols-2">
        {profileCard(t("compare.primaryPlayer"), primaryAid, primaryCurrent)}
        {profileCard(t("compare.secondaryPlayer"), secondaryAid, secondaryCurrent)}
      </section>

      {primaryProfile && (
        <>
          <section className="surface mt-6 p-5 md:p-8" aria-labelledby="compare-insights-title">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="section-kicker">{t("compare.insightsKicker")}</p>
                <h2 id="compare-insights-title" className="section-heading mt-2">{t("compare.insightsTitle")}</h2>
              </div>
              <Link prefetch={false} href="/population/regular" className="ghost-button">
                {t("compare.population")}
              </Link>
            </div>

            <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)] lg:items-center">
              <div>
                <p className="metric-card__label">{t("compare.medianPercentilesTitle")}</p>
                <p className="mt-2 text-5xl font-bold tracking-tight text-[var(--foreground)] tabular-nums" style={{ fontFamily: "var(--heading-font)" }}>
                  {formatPercentile(median, lang)}
                </p>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--muted)]">{t("compare.medianPercentilesNote")}</p>
              </div>
              <dl className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-[var(--card-border)] bg-[var(--input-bg)] p-3">
                  <dt className="text-xs uppercase tracking-wider text-[var(--muted)]">{t("compare.cohortSize")}</dt>
                  <dd className="mt-2 text-lg font-semibold tabular-nums text-[var(--foreground)]">{cohortSize == null ? "—" : cohortSize.toLocaleString(lang)}</dd>
                </div>
                <div className="rounded-xl border border-[var(--card-border)] bg-[var(--input-bg)] p-3">
                  <dt className="text-xs uppercase tracking-wider text-[var(--muted)]">{t("compare.cohortWindow")}</dt>
                  <dd className="mt-2 text-lg font-semibold tabular-nums text-[var(--foreground)]">{cohortWindow == null ? "—" : `±${cohortWindow}%`}</dd>
                </div>
                <div className="rounded-xl border border-[var(--card-border)] bg-[var(--input-bg)] p-3">
                  <dt className="text-xs uppercase tracking-wider text-[var(--muted)]">{t("compare.cohortHours")}</dt>
                  <dd className="mt-2 font-semibold tabular-nums text-[var(--foreground)]">{formatRange(actualHours, lang, 1)}</dd>
                </div>
                <div className="rounded-xl border border-[var(--card-border)] bg-[var(--input-bg)] p-3">
                  <dt className="text-xs uppercase tracking-wider text-[var(--muted)]">{t("compare.cohortPmcRaids")}</dt>
                  <dd className="mt-2 font-semibold tabular-nums text-[var(--foreground)]">{formatRange(actualPmcRaids, lang)}</dd>
                </div>
              </dl>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
              {strategyLabel && <span className="rounded-full border border-[var(--card-border)] px-3 py-1 text-[var(--muted-strong)]">{strategyLabel}</span>}
              {cohort?.strategy === "population" && <span className="text-[var(--muted)]">{t("compare.cohortFallbackNote")}</span>}
            </div>
            {cohortLoading && <p className="profile-chart-notice" role="status">{t("compare.cohortLoading")}</p>}
            {!cohortLoading && cohortError && <p className="profile-chart-notice" role="alert">{cohortError}</p>}
            {!cohortLoading && !cohortError && cohortUnavailable && <p className="profile-chart-notice" role="status">{t("compare.cohortUnavailable")}</p>}
          </section>

          <section className="surface mt-6 p-5 md:p-6" aria-labelledby="compare-metrics-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="section-kicker">{t("compare.metricsKicker")}</p>
                <h2 id="compare-metrics-title" className="section-heading mt-2">{t("compare.metricsTitle")}</h2>
              </div>
              <span className="text-sm text-[var(--muted)]">{t("compare.sixMetrics")}</span>
            </div>
            {primaryStats && !primaryKnown && <p className="profile-chart-notice" role="alert">{t("compare.profileIncomplete")}</p>}
            {secondaryStats && !secondaryKnown && <p className="profile-chart-notice" role="alert">{t("compare.profileIncomplete")}</p>}
            {secondaryAid === null && <p className="mt-4 text-sm text-[var(--muted)]">{t("compare.secondPrompt")}</p>}
            <div className="mt-5">
              <ComparisonTable nameA={primaryName || t("compare.primaryPlayer")} nameB={secondaryName || t("compare.secondaryPlayer")} rows={rows} />
            </div>
          </section>

          <section className="surface mt-6 p-5 md:p-6" aria-labelledby="compare-ranks-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="section-kicker">{t("compare.ranksKicker")}</p>
                <h2 id="compare-ranks-title" className="section-heading mt-2">{t("compare.ranksTitle")}</h2>
              </div>
              {cohort && <span className="text-sm text-[var(--muted)]">{t("compare.percentileBasis")}</span>}
            </div>
            {ranked.length > 0 ? (
              ranked.length === 1 ? (
                <div className="mt-5">
                  <RankedMetricList title={t("compare.ranksKicker")} items={ranked} />
                </div>
              ) : (
                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  <RankedMetricList title={t("compare.strengths")} items={strengths} />
                  <RankedMetricList title={t("compare.weaknesses")} items={weaknesses} />
                </div>
              )
            ) : (
              <p className="mt-5 text-sm text-[var(--muted)]" role="status">{cohortLoading ? t("compare.cohortLoading") : t("compare.noPercentiles")}</p>
            )}
          </section>
        </>
      )}

      {primaryAid !== null && (
        <div className="mt-6 flex flex-wrap gap-3">
          <Link prefetch={false} href={`/player/regular/${primaryAid}`} className="ghost-button">{t("compare.fullProfile")}</Link>
          {secondaryAid !== null && <Link prefetch={false} href={`/player/regular/${secondaryAid}`} className="ghost-button">{t("compare.secondaryFullProfile")}</Link>}
          <Link prefetch={false} href="/population/regular" className="ghost-button">{t("compare.population")}</Link>
        </div>
      )}
    </main>
  );
}
