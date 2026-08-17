"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import ProgressionTimelineChart from "@/components/ProgressionTimelineChart";
import StatCard from "@/components/StatCard";
import { useFavorites } from "@/lib/favorites/context";
import { favoriteKey } from "@/lib/favorites/identity";
import { useI18n } from "@/lib/i18n/context";
import type { LevelBand } from "@/lib/seasonal/ui";
import type { ProgressionTimelineResponse } from "@/types/seasonal";

const timelineCache = new Map<string, ProgressionTimelineResponse>();

interface SecondaryTimeline {
  aid: number;
  nickname: string;
  timeline: ProgressionTimelineResponse;
}

interface ComparisonSelection {
  ownerKey: string;
  aid: string;
}

export interface ProgressionRiskPayload {
  combined: number;
  static: number | null;
  progression: number | null;
  confidence: { value: number; tier: "low" | "medium" | "high" };
  staticContribution: number;
  progressionContribution: number;
  staticReasons: string[];
  reasons: string[];
}

function number(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function validRisk(value: unknown): value is ProgressionRiskPayload {
  if (!value || typeof value !== "object") return false;
  const risk = value as Partial<ProgressionRiskPayload>;
  return Number.isFinite(risk.combined) &&
    (risk.static === null || Number.isFinite(risk.static)) &&
    (risk.progression === null || Number.isFinite(risk.progression)) &&
    Boolean(risk.confidence && Number.isFinite(risk.confidence.value)) &&
    Number.isFinite(risk.staticContribution) &&
    Number.isFinite(risk.progressionContribution) &&
    Array.isArray(risk.staticReasons) &&
    Array.isArray(risk.reasons);
}

function validTimelineResponse(
  value: unknown,
  expected: { aid: number; mode: string; cycleId: string },
): value is ProgressionTimelineResponse {
  if (!value || typeof value !== "object") return false;
  const timeline = value as Partial<ProgressionTimelineResponse>;
  const metrics = timeline.metrics;
  const validMetric = (series: unknown): boolean => {
    if (!series || typeof series !== "object") return false;
    const candidate = series as Record<string, unknown>;
    return ["player", "nearby", "overall"].every((key) => Array.isArray(candidate[key]));
  };
  return Boolean(
    timeline.identity &&
      timeline.identity.aid === expected.aid &&
      timeline.identity.mode === expected.mode &&
      timeline.identity.cycleId === expected.cycleId &&
      metrics &&
      typeof metrics === "object" &&
      !Array.isArray(metrics) &&
      Object.values(metrics).every(validMetric) &&
      timeline.history &&
      typeof timeline.history === "object" &&
      typeof timeline.n === "number" &&
      Number.isFinite(timeline.n) &&
      typeof timeline.confidence === "number" &&
      Number.isFinite(timeline.confidence),
  );
}

function timelineHasPoints(timeline: ProgressionTimelineResponse | null): boolean {
  return Boolean(timeline && Object.values(timeline.metrics).some((metric) =>
    metric && [metric.player, metric.nearby, metric.overall].some((series) =>
      Array.isArray(series) && series.length > 0,
    ),
  ));
}

function timelineHasPlayerHistory(timeline: ProgressionTimelineResponse | null): boolean {
  if (!timeline) return false;
  return [timeline.metrics.xp, timeline.metrics.pvp_kd, timeline.metrics.ai_kd, timeline.metrics.survival]
    .some((metric) => Boolean(metric && Array.isArray(metric.player) && metric.player.length > 0));
}

export default function ProgressionPanel({
  aid,
  onRiskChange,
  mode = "regular",
  cycleId = "persistent",
  profileUpdatedAt,
  refreshRevision = 0,
  forceRefresh = false,
}: {
  aid: number;
  hours: number;
  pmcRaids: number;
  onRiskChange?: (risk: ProgressionRiskPayload | null) => void;
  mode?: "regular" | "seasonal";
  cycleId?: string;
  levelBands?: LevelBand[];
  profileUpdatedAt?: number | null;
  refreshRevision?: number;
  forceRefresh?: boolean;
}) {
  const { t } = useI18n();
  const {
    enabled: favoritesEnabled,
    loading: favoritesLoading,
    authStatus,
    favorites,
  } = useFavorites();
  const [data, setData] = useState<ProgressionTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mainIdentityKey = `${mode}\0${cycleId}\0${aid}`;
  const [selection, setSelection] = useState<ComparisonSelection>(() => ({ ownerKey: mainIdentityKey, aid: "" }));
  const selectedAid = selection.ownerKey === mainIdentityKey ? selection.aid : "";
  const [secondary, setSecondary] = useState<SecondaryTimeline | null>(null);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [secondaryError, setSecondaryError] = useState(false);
  const secondaryGeneration = useRef(0);
  const secondaryController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const cacheKey = `${mode}\0${cycleId}\0${aid}`;
    const cached = timelineCache.get(cacheKey) ?? null;
    const abortForNavigation = () => controller.abort();
    window.addEventListener("profile-mode-navigate", abortForNavigation, { once: true });
    setLoading(cached === null);
    setError(false);
    setData(cached);
    onRiskChange?.(cached?.history?.ready && validRisk(cached.risk) ? cached.risk : null);

    const loadTimeline = async () => {
      try {
        const params = new URLSearchParams({
          mode,
          cycle: cycleId,
          aid: String(aid),
        });
        const response = await fetch(`/api/progression/timeline?${params}`, {
          signal: controller.signal,
          cache: forceRefresh || refreshRevision > 0 ? "no-store" : "default",
        });
        if (!response.ok) throw new Error(t("progression.unavailable"));
        const result: unknown = await response.json();
        if (!response.ok || !validTimelineResponse(result, { aid, mode, cycleId })) {
          throw new Error(t("progression.unavailable"));
        }
        if (controller.signal.aborted) return;
        timelineCache.set(cacheKey, result);
        startTransition(() => {
          setData(result);
          onRiskChange?.(result.history?.ready && validRisk(result.risk) ? result.risk : null);
        });
      } catch (caught: unknown) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (!controller.signal.aborted && !cached) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void loadTimeline();

    return () => {
      window.removeEventListener("profile-mode-navigate", abortForNavigation);
      controller.abort();
    };
  }, [aid, cycleId, forceRefresh, mode, onRiskChange, profileUpdatedAt, refreshRevision, t]);

  const history = data?.history;
  const longTerm = data?.longTerm;
  const hasPoints = timelineHasPoints(data);
  const eligibleFavorites = useMemo(
    () => favorites.filter((favorite) =>
      favorite.mode === mode && favorite.cycleId === cycleId && favorite.aid !== aid,
    ),
    [aid, cycleId, favorites, mode],
  );
  const selectedFavorite = eligibleFavorites.find((favorite) => String(favorite.aid) === selectedAid) ?? null;
  const selectedNickname = selectedFavorite
    ? selectedFavorite.nickname?.trim() || t("progression.compare.playerId", { aid: selectedFavorite.aid })
    : "";
  const selectedCacheKey = selectedFavorite
    ? `${mode}\0${cycleId}\0${selectedFavorite.aid}`
    : null;
  const cachedSecondary = selectedCacheKey ? timelineCache.get(selectedCacheKey) ?? null : null;
  const secondaryCandidate = selectedFavorite && secondary?.aid === selectedFavorite.aid
    ? secondary.timeline
    : cachedSecondary;
  const activeSecondary = selectedFavorite && secondaryCandidate && validTimelineResponse(
    secondaryCandidate,
    { aid: selectedFavorite.aid, mode, cycleId },
  )
    ? { aid: selectedFavorite.aid, nickname: selectedNickname, timeline: secondaryCandidate }
    : null;
  const mainReady = !loading && !error && Boolean(data) && hasPoints;
  const compareNotice = favoritesLoading
    ? t("progression.compare.loadingFavorites")
    : authStatus === "loading"
      ? t("progression.compare.authLoading")
      : !favoritesEnabled
        ? authStatus === "error"
          ? t("progression.compare.authError")
          : t("progression.compare.authRequired")
        : favorites.length === 0
          ? t("progression.compare.noFavorites")
          : eligibleFavorites.length === 0
            ? t("progression.compare.noEligible")
            : loading
              ? t("progression.compare.historyLoading")
              : error || !data || !hasPoints
                ? t("progression.compare.noHistory")
                : "";
  const secondaryHasPoints = timelineHasPlayerHistory(activeSecondary?.timeline ?? null);
  const showSecondaryLoading = Boolean(selectedFavorite && !activeSecondary && secondaryLoading);
  const showSecondaryError = Boolean(selectedFavorite && secondaryError);

  const selectComparison = (nextAid: string) => {
    secondaryController.current?.abort();
    secondaryController.current = null;
    secondaryGeneration.current += 1;
    setSelection({ ownerKey: mainIdentityKey, aid: nextAid });
    setSecondary(null);
    setSecondaryLoading(Boolean(nextAid));
    setSecondaryError(false);
  };

  useEffect(() => {
    secondaryController.current?.abort();
    secondaryController.current = null;
    secondaryGeneration.current += 1;
    setSelection({ ownerKey: mainIdentityKey, aid: "" });
    setSecondary(null);
    setSecondaryLoading(false);
    setSecondaryError(false);
  }, [mainIdentityKey]);

  useEffect(() => {
    if (selectedAid && !eligibleFavorites.some((favorite) => String(favorite.aid) === selectedAid)) {
      secondaryController.current?.abort();
      secondaryController.current = null;
      secondaryGeneration.current += 1;
      setSelection({ ownerKey: mainIdentityKey, aid: "" });
      setSecondary(null);
      setSecondaryLoading(false);
      setSecondaryError(false);
    }
  }, [eligibleFavorites, mainIdentityKey, selectedAid]);

  useEffect(() => {
    secondaryController.current?.abort();
    secondaryController.current = null;
    const generation = ++secondaryGeneration.current;
    const favorite = eligibleFavorites.find((item) => String(item.aid) === selectedAid);
    if (!favorite) {
      setSecondary(null);
      setSecondaryLoading(false);
      setSecondaryError(false);
      return;
    }

    const controller = new AbortController();
    secondaryController.current = controller;
    const cacheKey = `${mode}\0${cycleId}\0${favorite.aid}`;
    const cached = timelineCache.get(cacheKey) ?? null;
    const nickname = favorite.nickname?.trim() || t("progression.compare.playerId", { aid: favorite.aid });
    setSecondary(cached ? { aid: favorite.aid, nickname, timeline: cached } : null);
    setSecondaryLoading(cached === null);
    setSecondaryError(false);

    const loadSecondary = async () => {
      try {
        const params = new URLSearchParams({
          mode,
          cycle: cycleId,
          aid: String(favorite.aid),
        });
        const response = await fetch(`/api/progression/timeline?${params}`, {
          signal: controller.signal,
          cache: "default",
        });
        const result: unknown = await response.json();
        if (!response.ok || !validTimelineResponse(result, { aid: favorite.aid, mode, cycleId })) {
          throw new Error(t("progression.compare.error"));
        }
        if (controller.signal.aborted || generation !== secondaryGeneration.current) return;
        timelineCache.set(cacheKey, result);
        startTransition(() => {
          if (controller.signal.aborted || generation !== secondaryGeneration.current) return;
          setSecondary({ aid: favorite.aid, nickname, timeline: result });
          setSecondaryError(false);
        });
      } catch (caught: unknown) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (!controller.signal.aborted && generation === secondaryGeneration.current) {
          setSecondaryError(true);
        }
      } finally {
        if (!controller.signal.aborted && generation === secondaryGeneration.current) {
          setSecondaryLoading(false);
        }
      }
    };

    void loadSecondary();
    return () => {
      controller.abort();
      if (secondaryController.current === controller) secondaryController.current = null;
    };
  }, [cycleId, eligibleFavorites, mode, selectedAid, t]);

  return (
    <section className="mt-5" aria-labelledby="progression-heading">
      <div className="seasonal-controls">
        <div>
          <span className="section-kicker">{t(mode === "regular" ? "progression.kicker" : "seasonal.kind.cumulative")}</span>
          <h2 id="progression-heading" className="section-heading">{t("player.progression")}</h2>
        </div>
      </div>

      {data?.comparison.status === "warming" && (
        <div className="data-panel mt-4 p-5" role="status">
          <p className="text-sm text-[var(--muted)]">{t("progression.comparisonWarming")}</p>
        </div>
      )}

      <div className="data-panel mt-4 p-4 sm:p-5">
        <label
          htmlFor={`progression-compare-${mode}-${cycleId}-${aid}`}
          className="grid gap-2 text-sm text-[var(--muted)]"
        >
          <span className="font-semibold text-[var(--foreground)]">{t("progression.compare.label")}</span>
          <select
            id={`progression-compare-${mode}-${cycleId}-${aid}`}
            value={selectedAid}
            disabled={!mainReady || favoritesLoading || !favoritesEnabled || eligibleFavorites.length === 0}
            onChange={(event) => selectComparison(event.target.value)}
            className="progression-timeline__compare-select min-h-11 w-full rounded border border-[var(--card-border)] bg-[var(--input-bg)] px-3 text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            aria-busy={showSecondaryLoading || loading}
          >
            <option value="">{t("progression.compare.clear")}</option>
            {eligibleFavorites.map((favorite) => (
              <option key={favoriteKey(favorite)} value={String(favorite.aid)}>
                {favorite.nickname?.trim() || t("progression.compare.playerId", { aid: favorite.aid })}
              </option>
            ))}
          </select>
        </label>
        {compareNotice && (
          <p className="mt-2 text-sm text-[var(--muted)]" role="status" aria-live="polite">
            {compareNotice}
          </p>
        )}
        {showSecondaryLoading && (
          <p className="mt-2 text-sm text-[var(--muted)]" role="status" aria-live="polite">
            {t("progression.compare.loading")}
          </p>
        )}
        {showSecondaryError && (
          <p className="mt-2 text-sm text-[var(--danger)]" role="status" aria-live="polite">
            {t("progression.compare.error")}
          </p>
        )}
        {activeSecondary && !showSecondaryLoading && !secondaryHasPoints && !showSecondaryError && (
          <p className="mt-2 text-sm text-[var(--muted)]" role="status" aria-live="polite">
            {t("progression.compare.noHistory")}
          </p>
        )}
      </div>

      {loading && (
        <div className="mt-4 grid gap-4" role="status" aria-label={t("common.loading")}>
          <div className="h-72 skeleton rounded-xl" />
        </div>
      )}

      {error && (
        <div className="data-panel mt-4 p-5" role="status">
          <p className="text-sm text-[var(--muted)]">{t("progression.unavailable")}</p>
        </div>
      )}

      {!loading && !error && (
        <>
          {history && !history.ready && !hasPoints && (
            <div className="data-panel mt-4 p-5" role="status">
              <p className="text-sm text-[var(--muted)]">{t("progression.collecting")}</p>
            </div>
          )}

          {data && (hasPoints || history?.ready) && (
            <ProgressionTimelineChart
              data={data}
              title={t("progression.timeline.title")}
              comparison={activeSecondary && secondaryHasPoints ? activeSecondary : undefined}
            />
          )}

          {history && (
            <div className="seasonal-chart__meta mt-4">
              <span>{t(history.ready ? "progression.ready" : "progression.collecting")}</span>
              <span>{t("progression.baselineSnapshot", { n: history.snapshotCount > 0 ? 1 : 0 })}</span>
              <span>{t("progression.snapshots", { n: history.snapshotCount })}</span>
              <span>{t("progression.intervals", { n: history.intervalCount })}</span>
              <span>{t("progression.allIntervals", { n: history.allIntervalCount ?? history.intervalCount })}</span>
              <span>{t("progression.changedIntervals", { n: history.changedIntervalCount ?? history.intervalCount })}</span>
              <span>{t("progression.raidIntervals", { n: history.raidIntervalCount ?? 0 })}</span>
              <span>{t("progression.tempoPoints", { n: history.tempoPointCount ?? 0 })}</span>
              <span>{t("progression.formPoints", { n: history.formPointCount ?? 0 })}</span>
              {history.firstObservedAt && (
                <span>{t("progression.firstObserved", { date: new Date(history.firstObservedAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>
              )}
              {history.lastObservedAt && (
                <span>{t("progression.lastObserved", { date: new Date(history.lastObservedAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>
              )}
            </div>
          )}

          {history?.ready && <section className="mt-5">
            <h3 className="section-heading mb-3">{t("seasonal.longTerm")}</h3>
            <div className="data-ledger">
              <StatCard label={t("seasonal.metric.survival")} value={number(longTerm?.survivalRate)} suffix="%" />
              <StatCard label={t("seasonal.metric.pvpKd")} value={number(longTerm?.pvpKd)} />
              <StatCard label={t("seasonal.metric.aiKd")} value={number(longTerm?.aiKd)} />
              <StatCard label={t("seasonal.metric.overallPmcKd")} value={number(longTerm?.overallPmcKd)} />
              <StatCard label={t("seasonal.metric.intervals")} value={longTerm?.intervals ?? history?.intervalCount ?? "—"} />
              <StatCard label={t("seasonal.metric.coveredRaids")} value={longTerm?.coveredRaids ?? "—"} />
            </div>
          </section>}
        </>
      )}
    </section>
  );
}
