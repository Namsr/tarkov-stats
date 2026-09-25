"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CompareProgressionSection from "@/components/CompareProgressionSection";
import ComparisonTable, { type ComparisonRow } from "@/components/ComparisonTable";
import PercentileBadge from "@/components/PercentileBadge";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import SearchBar from "@/components/SearchBar";
import SegmentedRadio from "@/components/SegmentedRadio";
import {
  adaptComparisonCohort,
  adaptComparisonProfile,
  comparisonCohortRequestUrl,
  comparisonProfileRequestUrl,
  comparisonScopeFromSearchParams,
} from "@/lib/comparison-adapter";
import { loadAverageJson } from "@/lib/client-average-request";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import { useI18n } from "@/lib/i18n/context";
import {
  ARENA_COMPARISON_METRIC_KEYS,
  PERSISTENT_COMPARISON_METRIC_KEYS,
  type ArenaComparisonScope,
  type ComparisonBenchmark,
  type ComparisonCohort,
  type ComparisonMetricKey,
  type ComparisonPercentile,
  type ComparisonProfile,
  type ComparisonScope,
  type PersistentComparisonScope,
} from "@/types/comparison";
import { appRouteMode, GAME_MODES, type GameMode } from "@/types/seasonal";

type Translate = ReturnType<typeof useI18n>["t"];
type AnyComparisonProfile = ComparisonProfile<PersistentComparisonScope> | ComparisonProfile<ArenaComparisonScope>;
type AnyComparisonCohort = ComparisonCohort<PersistentComparisonScope> | ComparisonCohort<ArenaComparisonScope>;

interface StoredProfile {
  profile: AnyComparisonProfile;
  updatedAt: number | null;
  profileSnapshot: string;
}

interface ProfileLoadState {
  scopeKey: string;
  aid: number | null;
  data: StoredProfile | null;
  loading: boolean;
  error: string;
  missing: boolean;
}

interface CohortLoadState {
  scopeKey: string;
  aid: number | null;
  data: AnyComparisonCohort | null;
  loading: boolean;
  error: string;
}

interface MetricDefinition {
  key: ComparisonMetricKey;
  labelKey: string;
  decimals: number;
  suffix?: string;
}

type RankedMetric = { key: ComparisonMetricKey; label: string; percentile: number };

const METRIC_DEFINITIONS = {
  kd_ratio: { key: "kd_ratio", labelKey: "radar.metric.kd", decimals: 2 },
  pmc_kd_ratio: { key: "pmc_kd_ratio", labelKey: "radar.metric.pmcKd", decimals: 2 },
  kills_per_raid: { key: "kills_per_raid", labelKey: "radar.metric.killsPerRaid", decimals: 2 },
  pmc_survival_rate: { key: "pmc_survival_rate", labelKey: "radar.metric.pmcSurvival", decimals: 1, suffix: "%" },
  longest_win_streak: { key: "longest_win_streak", labelKey: "radar.metric.winStreak", decimals: 0 },
  level: { key: "level", labelKey: "radar.metric.level", decimals: 0 },
  win_rate: { key: "win_rate", labelKey: "arena.metric.win_rate", decimals: 1, suffix: "%" },
  headshot_rate: { key: "headshot_rate", labelKey: "arena.metric.headshot_rate", decimals: 1, suffix: "%" },
  kills_per_match: { key: "kills_per_match", labelKey: "arena.metric.kills_per_match", decimals: 2 },
  damage_per_match: { key: "damage_per_match", labelKey: "arena.metric.damage_per_match", decimals: 0 },
} satisfies Record<ComparisonMetricKey, MetricDefinition>;

const METRICS: Readonly<Record<"persistent" | "arena", readonly MetricDefinition[]>> = {
  persistent: PERSISTENT_COMPARISON_METRIC_KEYS.map((key) => METRIC_DEFINITIONS[key]),
  arena: ARENA_COMPARISON_METRIC_KEYS.map((key) => METRIC_DEFINITIONS[key]),
};

function parseAid(value: string | null): number | null {
  if (!value) return null;
  const aid = Number(value);
  return Number.isSafeInteger(aid) && aid > 0 ? aid : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePercentile(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function responseCode(value: unknown): string {
  const body = record(value);
  return typeof body?.code === "string" ? body.code : "";
}

function captureStatus(value: unknown): string {
  const capture = record(record(value)?.capture);
  return typeof capture?.status === "string" ? capture.status : "";
}

function profileUpdatedAt(payload: unknown): number | null {
  const body = record(payload);
  if (!body) return null;
  const candidates = [
    body.profileUpdatedAt,
    record(body.freshness)?.profileUpdatedAt,
    record(body.arena)?.profileUpdatedAt,
    record(body.profile)?.profileUpdatedAt,
    record(body.stats)?.profileUpdatedAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return null;
}

function storedProfile(profile: AnyComparisonProfile, payload: unknown): StoredProfile {
  return {
    profile,
    updatedAt: profileUpdatedAt(payload),
    profileSnapshot: JSON.stringify(profile),
  };
}

function profileRevision(profile: StoredProfile): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < profile.profileSnapshot.length; index += 1) {
    hash ^= profile.profileSnapshot.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${profile.updatedAt ?? "unknown"}-${(hash >>> 0).toString(36)}`;
}

function profileValue(profile: AnyComparisonProfile | null, key: ComparisonMetricKey): number | null {
  if (!profile) return null;
  const metrics = profile.metrics as Partial<Record<ComparisonMetricKey, number | null>>;
  return finiteMetric(metrics[key]);
}

function benchmarkFor(cohort: AnyComparisonCohort | null, key: ComparisonMetricKey): number | null {
  if (!cohort) return null;
  const benchmarks = cohort.benchmarks as Partial<Record<ComparisonMetricKey, ComparisonBenchmark | undefined>>;
  const benchmark = benchmarks[key];
  if (!benchmark || benchmark.count <= 0) return null;
  return finiteMetric(benchmark.value);
}

function percentileFor(cohort: AnyComparisonCohort | null, key: ComparisonMetricKey): ComparisonPercentile | null {
  if (!cohort?.percentiles) return null;
  const percentiles = cohort.percentiles as Partial<Record<ComparisonMetricKey, ComparisonPercentile | undefined>>;
  return percentiles[key] ?? null;
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

function formatRange(
  range: { min: number; max: number } | null | undefined,
  lang: string,
  decimals = 0,
): string {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "—";
  return `${range.min.toLocaleString(lang, { maximumFractionDigits: decimals })}–${range.max.toLocaleString(lang, { maximumFractionDigits: decimals })}`;
}

function profileHref(scope: ComparisonScope, aid: number): string {
  const base = `/player/${appRouteMode(scope.mode)}/${aid}`;
  return scope.mode === "seasonal" ? `${base}?cycle=${encodeURIComponent(scope.cycleId)}` : base;
}

function populationHref(scope: ComparisonScope): string {
  const base = `/population/${appRouteMode(scope.mode)}`;
  return scope.mode === "seasonal" ? `${base}?cycle=${encodeURIComponent(scope.cycleId)}` : base;
}

function cohortRevisionRequestUrl(scope: ComparisonScope, aid: number, revision: string): string {
  const url = new URL(comparisonCohortRequestUrl(scope, aid), "http://local");
  url.searchParams.set("revision", revision);
  return `${url.pathname}${url.search}`;
}

function useComparisonProfile(
  scope: ComparisonScope | null,
  scopeKey: string,
  aid: number | null,
  modeLabel: string,
  t: Translate,
  onRefreshed?: (profile: StoredProfile) => Promise<void> | void,
) {
  const [state, setState] = useState<ProfileLoadState>(() => ({
    scopeKey,
    aid,
    data: null,
    loading: Boolean(scope && aid !== null),
    error: "",
    missing: false,
  }));
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!scope || aid === null) {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      setState({ scopeKey, aid: null, data: null, loading: false, error: "", missing: false });
      return;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    setState({ scopeKey, aid, data: null, loading: true, error: "", missing: false });
    loadPlayerProfileResponse<unknown>(comparisonProfileRequestUrl(scope, aid), { signal: controller.signal })
      .then(({ ok, status, body }) => {
        if (!active()) return;
        if (!ok) {
          const missing = status === 404 || responseCode(body) === "mode_profile_unavailable" || responseCode(body) === "profile_unavailable";
          setState({
            scopeKey,
            aid,
            data: null,
            loading: false,
            error: t(missing ? "compare.profileMissing" : "compare.profileLoadError", { mode: modeLabel }),
            missing,
          });
          return;
        }
        const adapted = adaptComparisonProfile(scope, aid, body) as AnyComparisonProfile | null;
        if (!adapted) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
        setState({ scopeKey, aid, data: storedProfile(adapted, body), loading: false, error: "", missing: false });
      })
      .catch(() => {
        if (active()) {
          setState({
            scopeKey,
            aid,
            data: null,
            loading: false,
            error: t("compare.profileLoadError", { mode: modeLabel }),
            missing: false,
          });
        }
      });
    return () => {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      controller.abort();
    };
  }, [aid, modeLabel, scope, scopeKey, t]);

  const refresh = useCallback(async (): Promise<RefreshCheckResult> => {
    if (!scope || aid === null) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
    const previous = state.scopeKey === scopeKey && state.aid === aid ? state.data : null;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    try {
      const { ok, body } = await loadPlayerProfileResponse<unknown>(
        comparisonProfileRequestUrl(scope, aid, { refresh: true }),
        { force: true, signal: controller.signal },
      );
      if (!active()) return "unchanged";
      if (!ok) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
      if (captureStatus(body) === "refresh_failed") throw new Error(t("player.refreshStatus.error"));
      const adapted = adaptComparisonProfile(scope, aid, body) as AnyComparisonProfile | null;
      if (!adapted) throw new Error(t("compare.profileLoadError", { mode: modeLabel }));
      const next = storedProfile(adapted, body);
      const changed = !previous || previous.updatedAt !== next.updatedAt || previous.profileSnapshot !== next.profileSnapshot;
      setState((current) => generation === requestGeneration.current && current.scopeKey === scopeKey && current.aid === aid
        ? { ...current, data: next, loading: false, error: "", missing: false }
        : current);
      if (active()) await onRefreshed?.(next);
      return changed ? "updated" : "unchanged";
    } catch (error) {
      setState((current) => generation === requestGeneration.current && current.scopeKey === scopeKey && current.aid === aid
        ? { ...current, loading: false }
        : current);
      throw error;
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  }, [aid, modeLabel, onRefreshed, scope, scopeKey, state, t]);

  return { state, refresh };
}

function useComparisonCohort(scope: ComparisonScope | null, scopeKey: string, aid: number | null, t: Translate) {
  const [state, setState] = useState<CohortLoadState>(() => ({
    scopeKey,
    aid,
    data: null,
    loading: Boolean(scope && aid !== null),
    error: "",
  }));
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const revision = useRef<{ scopeKey: string; aid: number; value: string } | null>(null);
  const revisionIdentity = useRef<string | null>(null);

  useEffect(() => {
    if (!scope || aid === null) {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      revision.current = null;
      revisionIdentity.current = null;
      setState({ scopeKey, aid: null, data: null, loading: false, error: "" });
      return;
    }
    const identity = `${scopeKey}:${aid}`;
    if (revisionIdentity.current !== identity) {
      revisionIdentity.current = identity;
      revision.current = null;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    const currentRevision = revision.current?.scopeKey === scopeKey && revision.current.aid === aid
      ? revision.current.value
      : null;
    const requestUrl = currentRevision
      ? cohortRevisionRequestUrl(scope, aid, currentRevision)
      : comparisonCohortRequestUrl(scope, aid);
    setState({ scopeKey, aid, data: null, loading: true, error: "" });
    loadAverageJson<unknown>(requestUrl, { signal: controller.signal })
      .then((body) => {
        if (!active()) return;
        const adapted = adaptComparisonCohort(scope, aid, body) as AnyComparisonCohort | null;
        if (!adapted) throw new Error("cohort identity mismatch");
        setState({ scopeKey, aid, data: adapted, loading: false, error: "" });
      })
      .catch(() => {
        if (active()) {
          setState({ scopeKey, aid, data: null, loading: false, error: t("compare.cohortError") });
        }
      });
    return () => {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      controller.abort();
    };
  }, [aid, scope, scopeKey, t]);

  const reload = useCallback(async (profile: StoredProfile) => {
    if (!scope || aid === null) return;
    const nextRevision = profileRevision(profile);
    revision.current = { scopeKey, aid, value: nextRevision };
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const active = () => generation === requestGeneration.current && !controller.signal.aborted;
    setState({ scopeKey, aid, data: null, loading: true, error: "" });
    try {
      const response = await fetch(cohortRevisionRequestUrl(scope, aid, nextRevision), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!active()) return;
      if (!response.ok) throw new Error("cohort request failed");
      const body: unknown = await response.json();
      if (!active()) return;
      const adapted = adaptComparisonCohort(scope, aid, body) as AnyComparisonCohort | null;
      if (!adapted) throw new Error("cohort identity mismatch");
      setState({ scopeKey, aid, data: adapted, loading: false, error: "" });
    } catch {
      if (active()) {
        setState({ scopeKey, aid, data: null, loading: false, error: t("compare.cohortError") });
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  }, [aid, scope, scopeKey, t]);

  return { state, reload };
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

export default function ComparePage({ seasonalCycleId }: { seasonalCycleId?: string | null }) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const resolution = useMemo(
    () => comparisonScopeFromSearchParams(searchParams, seasonalCycleId ?? null),
    [searchParams, seasonalCycleId],
  );
  const scope = resolution.status === "available" ? resolution.scope : null;
  const scopeKey = scope ? `${scope.mode}:${scope.cycleId}:${scope.arenaMode}` : "";
  const rawMode = searchParams.get("mode");
  const visibleMode: GameMode = GAME_MODES.includes(rawMode as GameMode) ? rawMode as GameMode : "regular";
  const modeLabel = (mode: GameMode) => {
    if (mode === "regular") return t("fav.mode.regular");
    if (mode === "pve") return t("fav.mode.pve");
    if (mode === "arena") return t("fav.mode.arena");
    return t("fav.mode.seasonal");
  };
  const modeOptions = GAME_MODES
    .filter((mode) => seasonalCycleId || mode !== "seasonal")
    .map((mode) => ({ value: mode, label: modeLabel(mode) }));
  const activeModeLabel = modeLabel(scope?.mode ?? visibleMode);
  const primaryAid = parseAid(searchParams.get("aid"));
  const secondaryAid = parseAid(searchParams.get("vs"));
  const cohortController = useComparisonCohort(scope, scopeKey, primaryAid, t);
  const primary = useComparisonProfile(scope, scopeKey, primaryAid, activeModeLabel, t, cohortController.reload);
  const secondary = useComparisonProfile(scope, scopeKey, secondaryAid, activeModeLabel, t);
  const cohortState = cohortController.state;
  const primaryCurrent = primary.state.scopeKey === scopeKey && primary.state.aid === primaryAid ? primary.state : null;
  const secondaryCurrent = secondary.state.scopeKey === scopeKey && secondary.state.aid === secondaryAid ? secondary.state : null;
  const cohortCurrent = cohortState.scopeKey === scopeKey && cohortState.aid === primaryAid ? cohortState : null;
  const primaryProfile = primaryCurrent?.data?.profile ?? null;
  const secondaryProfile = secondaryCurrent?.data?.profile ?? null;
  const primaryProgression = primaryAid === null ? null : {
    aid: primaryAid,
    nickname: primaryProfile?.nickname?.trim() || `#${primaryAid}`,
    updatedAt: primaryCurrent?.data?.updatedAt ?? null,
  };
  const secondaryProgression = secondaryAid === null ? null : {
    aid: secondaryAid,
    nickname: secondaryProfile?.nickname?.trim() || `#${secondaryAid}`,
    updatedAt: secondaryCurrent?.data?.updatedAt ?? null,
  };
  const cohort = cohortCurrent?.data ?? null;
  const supportsPercentiles = scope?.mode === "regular" || scope?.mode === "pve";
  const metricDefinitions = scope?.mode === "arena" ? METRICS.arena : METRICS.persistent;
  const ranked: RankedMetric[] = supportsPercentiles
    ? metricDefinitions.flatMap((metric) => {
        if (profileValue(primaryProfile, metric.key) === null) return [];
        const percentile = finitePercentile(percentileFor(cohort, metric.key)?.percentile);
        return percentile === null ? [] : [{ key: metric.key, label: t(metric.labelKey), percentile }];
      })
    : [];
  const strengths = [...ranked].sort((left, right) => right.percentile - left.percentile).slice(0, 2);
  const weaknesses = [...ranked].sort((left, right) => left.percentile - right.percentile).slice(0, 2);
  const median = medianPercentile(ranked.map((item) => item.percentile));
  const primaryName = primaryProfile?.nickname?.trim() || (primaryAid ? `#${primaryAid}` : "");
  const secondaryName = secondaryProfile?.nickname?.trim() || (secondaryAid ? `#${secondaryAid}` : "");
  const cohortLoading = primaryAid !== null && (cohortCurrent === null || cohortCurrent.loading);
  const cohortError = cohortCurrent?.error ?? "";
  const cohortUnavailable = cohort?.quality === "unavailable";
  const cohortSize = finiteMetric(cohort?.n);
  const cohortWindow = cohort?.quality === "sufficient" ? finiteMetric(cohort.percent) : null;
  const cohortReady = cohort?.quality === "sufficient";
  const actualHours = cohortReady ? cohort.actualRanges.hours : null;
  const actualRaids = cohortReady
    ? scope?.mode === "arena" ? cohort.actualRanges.raids : cohort.actualRanges.pmcRaids
    : null;
  const rows: ComparisonRow[] = metricDefinitions.map((metric) => ({
    key: metric.key,
    label: t(metric.labelKey),
    valueA: profileValue(primaryProfile, metric.key),
    valueB: profileValue(secondaryProfile, metric.key),
    benchmark: benchmarkFor(cohort, metric.key),
    percentile: supportsPercentiles && profileValue(primaryProfile, metric.key) !== null
      ? finitePercentile(percentileFor(cohort, metric.key)?.percentile)
      : null,
    decimals: metric.decimals,
    suffix: metric.suffix,
  }));
  const primaryIncomplete = primaryProfile !== null && rows.some((row) => row.valueA === null);
  const secondaryIncomplete = secondaryProfile !== null && rows.some((row) => row.valueB === null);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }),
    [lang],
  );

  function changeMode(mode: GameMode) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("mode", mode);
    params.delete("arenaMode");
    params.delete("cycle");
    if (mode === "seasonal" && seasonalCycleId) params.set("cycle", seasonalCycleId);
    const query = params.toString();
    router.replace(`/compare${query ? `?${query}` : ""}`, { scroll: false });
  }

  function updateSelection(slot: "primary" | "secondary", aid: number) {
    if (!scope) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(slot === "primary" ? "aid" : "vs", String(aid));
    const query = params.toString();
    router.replace(`/compare${query ? `?${query}` : ""}`, { scroll: false });
  }

  function profileCard(
    slot: "primary" | "secondary",
    label: string,
    aid: number | null,
    current: ProfileLoadState | null,
    refresh: () => Promise<RefreshCheckResult>,
  ) {
    if (!scope) return null;
    const loading = aid !== null && (current === null || current.loading);
    const data = current?.data ?? null;
    const name = data?.profile.nickname?.trim() || (aid !== null ? `#${aid}` : "");
    const updatedAt = data?.updatedAt ?? null;
    return (
      <article className="surface min-w-0 p-5" aria-busy={loading || undefined}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="section-kicker">{label}</p>
            <h2 className="mt-2 break-words text-xl font-bold text-[var(--foreground)]">{name || t("compare.choosePlayer")}</h2>
            {aid !== null && <p className="mt-1 text-sm text-[var(--muted)]">#{aid}</p>}
            {updatedAt !== null && (
              <time className="mt-1 block text-xs text-[var(--muted)]" dateTime={new Date(updatedAt).toISOString()}>
                {t("player.profileUpdated", { date: dateFormatter.format(updatedAt) })}
              </time>
            )}
          </div>
          {aid !== null && (
            <div className="flex flex-wrap items-start justify-end gap-2">
              <RefreshButton
                key={`${slot}:${scopeKey}:${aid}`}
                aid={aid}
                mode={scope.mode}
                updatedAt={updatedAt}
                missing={current?.missing}
                direct
                onCheck={refresh}
              />
              <Link prefetch={false} href={profileHref(scope, aid)} className="ghost-button">
                {t("compare.fullProfile")}
              </Link>
            </div>
          )}
        </div>
        {aid === null && <p className="mt-4 text-sm text-[var(--muted)]">{t("compare.choosePlayer")}</p>}
        {loading && <p className="mt-4 text-sm text-[var(--muted)]" role="status">{t("common.loading")}</p>}
        {!loading && current?.error && <p className="mt-4 text-sm text-[var(--danger)]" role="alert">{current.error}</p>}
      </article>
    );
  }

  const strategyLabel = cohort?.strategy === "population"
    ? t("compare.cohortPopulationFallback")
    : cohort?.strategy === "matched"
      ? t("compare.cohortMatched")
      : null;
  const bothPlayersSelected = primaryAid !== null && secondaryAid !== null;

  return (
    <main className="page-frame">
      <header>
        <p className="page-kicker">{t("compare.pageKicker")}</p>
        <h1 className="page-title">{t("compare.pageTitle")}</h1>
        <p className="mt-4 max-w-3xl text-[var(--muted)]">{t("compare.pageDescription")}</p>
      </header>

      <div className="mt-7 flex flex-wrap items-end justify-between gap-4">
        <SegmentedRadio
          name="compare-mode"
          legend={t("mode.selectorAria")}
          value={scope?.mode ?? visibleMode}
          options={modeOptions}
          onChange={changeMode}
        />
        {scope?.mode === "seasonal" && (
          <span className="rounded-full border border-[var(--card-border)] px-3 py-1 text-sm text-[var(--muted-strong)]">
            {t("compare.cycle", { cycle: scope.cycleId })}
          </span>
        )}
      </div>

      {!scope && (
        <section className="surface mt-6 p-6" role="status" aria-live="polite">
          <p className="section-kicker">{modeLabel(visibleMode)}</p>
          <h2 className="section-heading mt-2">
            {t(visibleMode === "seasonal" ? "seasonal.unavailable" : "mode.unavailable")}
          </h2>
          <p className="mt-3 max-w-2xl text-[var(--muted)]">
            {t(visibleMode === "seasonal" ? "seasonal.unavailableDescription" : "mode.unavailableDescription")}
          </p>
        </section>
      )}

      {scope && (
        <>
          <section className="mt-8 grid gap-5 md:grid-cols-2" aria-label={t("compare.searchPlayers")}>
            <div className="min-w-0">
              <h2 className="section-heading">{t("compare.primaryPlayer")}</h2>
              <SearchBar
                key={`primary:${scopeKey}`}
                fixedMode={scope.mode}
                cycleId={scope.cycleId}
                onSelect={(aid) => updateSelection("primary", aid)}
              />
            </div>
            <div className="min-w-0">
              <h2 className="section-heading">{t("compare.secondaryPlayer")}</h2>
              <SearchBar
                key={`secondary:${scopeKey}`}
                fixedMode={scope.mode}
                cycleId={scope.cycleId}
                onSelect={(aid) => updateSelection("secondary", aid)}
              />
            </div>
          </section>

          <section className="mt-6 grid gap-5 md:grid-cols-2">
            {profileCard("primary", t("compare.primaryPlayer"), primaryAid, primaryCurrent, primary.refresh)}
            {profileCard("secondary", t("compare.secondaryPlayer"), secondaryAid, secondaryCurrent, secondary.refresh)}
          </section>

          {bothPlayersSelected && scope.mode === "arena" && (
            <section className="surface mt-6 p-5 md:p-6" aria-labelledby="compare-progression-title">
              <h2 id="compare-progression-title" className="section-heading">{t("compare.progressionTitle")}</h2>
              <p className="mt-3 text-[var(--muted)]" role="status">{t("compare.progressionArenaUnavailable")}</p>
            </section>
          )}

          {bothPlayersSelected && scope.mode !== "arena" && (
            <div className="mt-6">
              <CompareProgressionSection
                key={`${scopeKey}:${primaryAid}:${secondaryAid}`}
                mode={scope.mode as 'regular'|'pve'|'seasonal'}
                cycleId={scope.cycleId}
                primary={primaryProgression}
                secondary={secondaryProgression}
              />
            </div>
          )}
        </>
      )}

      {scope && primaryProfile && (
        <>
          <section className="surface mt-6 p-5 md:p-8" aria-labelledby="compare-insights-title">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="section-kicker">{t("compare.insightsKicker", { mode: activeModeLabel })}</p>
                <h2 id="compare-insights-title" className="section-heading mt-2">{t("compare.insightsTitle")}</h2>
              </div>
              <Link prefetch={false} href={populationHref(scope)} className="ghost-button">
                {t("compare.population", { mode: activeModeLabel })}
              </Link>
            </div>

            <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)] lg:items-center">
              {supportsPercentiles ? (
                <div>
                  <p className="metric-card__label">{t("compare.medianPercentilesTitle")}</p>
                  <p className="mt-2 text-5xl font-bold tracking-tight text-[var(--foreground)] tabular-nums" style={{ fontFamily: "var(--heading-font)" }}>
                    {formatPercentile(median, lang)}
                  </p>
                  <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--muted)]">{t("compare.medianPercentilesNote")}</p>
                </div>
              ) : (
                <div>
                  <p className="metric-card__label">{t("compare.cohortBenchmark")}</p>
                  <p className="mt-3 max-w-xl text-lg font-semibold text-[var(--foreground)]">{t("compare.benchmarkOnly")}</p>
                </div>
              )}
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
                  <dt className="text-xs uppercase tracking-wider text-[var(--muted)]">
                    {t(scope.mode === "arena" ? "compare.cohortMatches" : "compare.cohortPmcRaids")}
                  </dt>
                  <dd className="mt-2 font-semibold tabular-nums text-[var(--foreground)]">{formatRange(actualRaids, lang)}</dd>
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
                <p className="section-kicker">{t("compare.metricsKicker", { count: rows.length })}</p>
                <h2 id="compare-metrics-title" className="section-heading mt-2">{t("compare.metricsTitle")}</h2>
              </div>
              <span className="text-sm text-[var(--muted)]">{t("compare.metricCount", { count: rows.length })}</span>
            </div>
            {(primaryIncomplete || secondaryIncomplete) && <p className="profile-chart-notice" role="status">{t("compare.profileIncomplete")}</p>}
            {secondaryAid === null && <p className="mt-4 text-sm text-[var(--muted)]">{t("compare.secondPrompt")}</p>}
            <div className="mt-5">
              <ComparisonTable
                nameA={primaryName || t("compare.primaryPlayer")}
                nameB={secondaryName || t("compare.secondaryPlayer")}
                rows={rows}
                showPercentile={supportsPercentiles}
              />
            </div>
          </section>

          {supportsPercentiles && (
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
          )}
        </>
      )}

      {scope && primaryAid !== null && (
        <div className="mt-6 flex flex-wrap gap-3">
          <Link prefetch={false} href={profileHref(scope, primaryAid)} className="ghost-button">{t("compare.fullProfile")}</Link>
          {secondaryAid !== null && <Link prefetch={false} href={profileHref(scope, secondaryAid)} className="ghost-button">{t("compare.secondaryFullProfile")}</Link>}
          <Link prefetch={false} href={populationHref(scope)} className="ghost-button">{t("compare.population", { mode: activeModeLabel })}</Link>
        </div>
      )}
    </main>
  );
}
