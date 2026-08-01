"use client";

import { useEffect, useState } from "react";
import SeasonalProgressionChart from "@/components/SeasonalProgressionChart";
import StatCard from "@/components/StatCard";
import { useI18n } from "@/lib/i18n/context";
import type { LevelBand } from "@/lib/seasonal/ui";
import type {
  ProgressionKind,
  ProgressionSeriesResponse,
} from "@/types/seasonal";

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

interface LongTermPayload {
  xpPerDay: number | null;
  raidsPerDay: number | null;
  pmcKillsPerDay: number | null;
  pmcKillsPerRaid: number | null;
  nonPmcKillsPerDay: number | null;
  nonPmcKillsPerRaid: number | null;
  survivalRate: number | null;
  pvpKd: number | null;
  aiKd: number | null;
  overallPmcKd: number | null;
  intervals: number;
  coveredRaids: number;
}

interface HistoryPayload {
  snapshotCount: number;
  intervalCount: number;
  ready: boolean;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
}

type ProgressionResponse = ProgressionSeriesResponse & {
  risk?: ProgressionRiskPayload;
  longTerm?: LongTermPayload;
  history?: HistoryPayload;
};

const PROGRESSION_KINDS = ["cumulative", "tempo", "form"] as const satisfies readonly ProgressionKind[];

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
  levelBands = [],
  profileUpdatedAt,
  refreshRevision = 0,
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
}) {
  const { t } = useI18n();
  const [series, setSeries] = useState<Partial<Record<ProgressionKind, ProgressionResponse>>>({});
  const [completedRequests, setCompletedRequests] = useState(0);
  const [successfulRequests, setSuccessfulRequests] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setCompletedRequests(0);
    setSuccessfulRequests(0);
    setSeries({});
    onRiskChange?.(null);

    const loadKind = async (kind: ProgressionKind) => {
      try {
        const params = new URLSearchParams({
          mode,
          cycle: cycleId,
          aid: String(aid),
          kind,
        });
        const response = await fetch(`/api/progression?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(t("progression.unavailable"));
        const result = (await response.json()) as ProgressionResponse;
        if (controller.signal.aborted) return;
        setSeries((current) => ({ ...current, [kind]: result }));
        setSuccessfulRequests((current) => current + 1);
        onRiskChange?.(result.history?.ready && validRisk(result.risk) ? result.risk : null);
      } catch (caught: unknown) {
        if (caught instanceof Error && caught.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) {
          setCompletedRequests((current) => current + 1);
        }
      }
    };

    void loadKind("cumulative").finally(() => {
      if (controller.signal.aborted) return;
      void loadKind("tempo");
      void loadKind("form");
    });

    return () => controller.abort();
  }, [aid, cycleId, mode, onRiskChange, profileUpdatedAt, refreshRevision, t]);

  const loading = successfulRequests === 0 && completedRequests < PROGRESSION_KINDS.length;
  const error = successfulRequests === 0 && completedRequests === PROGRESSION_KINDS.length;
  const details = series.cumulative ?? series.tempo ?? series.form;
  const longTerm = details?.longTerm;
  const history = details?.history;
  const hasPoints = (data: ProgressionSeriesResponse | undefined) =>
    Boolean(data && (data.player.length || data.nearby.length || data.overall.length));
  const hasCumulative = hasPoints(series.cumulative);
  const hasTempo = hasPoints(series.tempo);
  const hasForm = hasPoints(series.form);

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
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-72 skeleton rounded-xl" />
          ))}
        </div>
      )}

      {error && (
        <div className="data-panel mt-4 p-5" role="status">
          <p className="text-sm text-[var(--muted)]">{t("progression.unavailable")}</p>
        </div>
      )}

      {!loading && !error && (
        <>
          {history && !history.ready && !hasCumulative && !hasTempo && !hasForm && (
            <div className="data-panel mt-4 p-5" role="status">
              <p className="text-sm text-[var(--muted)]">{t("progression.collecting")}</p>
            </div>
          )}

          {hasCumulative && series.cumulative && (
            <SeasonalProgressionChart
              data={series.cumulative}
              title={t(mode === "regular" ? "progression.chart.xp" : "seasonal.chart.xp")}
              levelBands={levelBands}
              mode={mode}
            />
          )}
          {hasTempo && series.tempo && (
            <SeasonalProgressionChart
              data={series.tempo}
              title={t(mode === "regular" ? "progression.chart.tempo" : "seasonal.chart.tempo")}
              mode={mode}
            />
          )}
          {hasForm && series.form && (
            <SeasonalProgressionChart
              data={series.form}
              title={t(mode === "regular" ? "progression.chart.form" : "seasonal.chart.form")}
              mode={mode}
            />
          )}

          {history && (
            <div className="seasonal-chart__meta mt-4">
              <span>{t(history.ready ? "progression.ready" : "progression.collecting")}</span>
              <span>{t("progression.snapshots", { n: history.snapshotCount })}</span>
              <span>{t("progression.intervals", { n: history.intervalCount })}</span>
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
              <StatCard label={t("seasonal.metric.xpPerDay")} value={number(longTerm?.xpPerDay, 0)} />
              <StatCard label={t("seasonal.metric.raidsPerDay")} value={number(longTerm?.raidsPerDay)} />
              <StatCard label={t("seasonal.metric.pmcKillsPerDay")} value={number(longTerm?.pmcKillsPerDay)} />
              <StatCard label={t("seasonal.metric.pmcKillsPerRaid")} value={number(longTerm?.pmcKillsPerRaid)} />
              <StatCard label={t("seasonal.metric.nonPmcKillsPerDay")} value={number(longTerm?.nonPmcKillsPerDay)} />
              <StatCard label={t("seasonal.metric.nonPmcKillsPerRaid")} value={number(longTerm?.nonPmcKillsPerRaid)} />
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
