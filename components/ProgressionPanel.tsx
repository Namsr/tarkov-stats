"use client";

import { useEffect, useState } from "react";
import ProgressionTimelineChart from "@/components/ProgressionTimelineChart";
import StatCard from "@/components/StatCard";
import { useI18n } from "@/lib/i18n/context";
import type { LevelBand } from "@/lib/seasonal/ui";
import type { ProgressionTimelineResponse } from "@/types/seasonal";

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
  const [data, setData] = useState<ProgressionTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setData(null);
    onRiskChange?.(null);

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
        const result = (await response.json()) as ProgressionTimelineResponse;
        if (controller.signal.aborted) return;
        setData(result);
        onRiskChange?.(result.history?.ready && validRisk(result.risk) ? result.risk : null);
      } catch (caught: unknown) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void loadTimeline();

    return () => controller.abort();
  }, [aid, cycleId, forceRefresh, mode, onRiskChange, profileUpdatedAt, refreshRevision, t]);

  const history = data?.history;
  const longTerm = data?.longTerm;
  const hasPoints = Boolean(data && Object.values(data.metrics).some((metric) =>
    metric && (metric.player.length || metric.nearby.length || metric.overall.length),
  ));

  return (
    <section className="mt-5" aria-labelledby="progression-heading">
      <div className="seasonal-controls">
        <div>
          <span className="section-kicker">{t(mode === "regular" ? "progression.kicker" : "seasonal.kind.cumulative")}</span>
          <h2 id="progression-heading" className="section-heading">{t("player.progression")}</h2>
        </div>
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
