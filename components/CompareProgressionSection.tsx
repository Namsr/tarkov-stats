"use client";

import { useEffect, useId, useState } from "react";
import ProgressionTimelineChart from "@/components/ProgressionTimelineChart";
import { useI18n } from "@/lib/i18n/context";
import { comparisonTimelineBenchmark } from "@/lib/comparison-dossier";
import {
  timelineHasPlayerHistory,
  validTimelineResponse,
} from "@/lib/progression-timeline-response";
import type { ProgressionMetricKey, ProgressionTimelineResponse } from "@/types/seasonal";
import "@/components/profile.css";

export type ProgressionMode = "regular" | "pve" | "seasonal";

type ComparePlayer = {
  aid: number;
  nickname: string;
  updatedAt?: number | null;
};

type CompareProgressionSectionProps = {
  mode: ProgressionMode;
  cycleId: string;
  primary: ComparePlayer | null;
  secondary: ComparePlayer | null;
};

type TimelineSlotState = {
  key: string;
  timeline: ProgressionTimelineResponse | null;
  loading: boolean;
  error: boolean;
};

function useProgressionTimeline(
  player: ComparePlayer | null,
  mode: ProgressionMode,
  cycleId: string,
): TimelineSlotState {
  const aid = player?.aid ?? null;
  const updatedAt = player?.updatedAt ?? null;
  const key = player ? `${mode}\0${cycleId}\0${player.aid}\0${updatedAt ?? ""}` : "";
  const [state, setState] = useState<TimelineSlotState>({
    key: "",
    timeline: null,
    loading: false,
    error: false,
  });

  useEffect(() => {
    if (aid === null) {
      setState({ key, timeline: null, loading: false, error: false });
      return;
    }

    const controller = new AbortController();
    let active = true;
    setState({ key, timeline: null, loading: true, error: false });

    const loadTimeline = async () => {
      try {
        const params = new URLSearchParams({
          aid: String(aid),
          mode,
          cycle: cycleId,
        });
        const response = await fetch(`/api/progression/timeline?${params}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const result: unknown = await response.json();
        if (!response.ok || !validTimelineResponse(result, { aid, mode, cycleId })) {
          throw new Error();
        }
        if (!active || controller.signal.aborted) return;
        setState({ key, timeline: result, loading: false, error: false });
      } catch (caught: unknown) {
        if (!active || controller.signal.aborted || (caught instanceof Error && caught.name === "AbortError")) return;
        setState({ key, timeline: null, loading: false, error: true });
      }
    };

    void loadTimeline();
    return () => {
      active = false;
      controller.abort();
    };
  }, [aid, cycleId, key, mode, updatedAt]);

  if (state.key === key) return state;
  return {
    key,
    timeline: null,
    loading: aid !== null,
    error: false,
  };
}

function TimelineSlot({
  label,
  player,
  state,
  emptyMessage,
  loadingMessage,
  errorMessage,
  noHistoryMessage,
  readyMessage,
}: {
  label: string;
  player: ComparePlayer | null;
  state: TimelineSlotState;
  emptyMessage: string;
  loadingMessage: string;
  errorMessage: string;
  noHistoryMessage: string;
  readyMessage: string;
}) {
  const ready = Boolean(player && state.timeline && timelineHasPlayerHistory(state.timeline));
  return <article
    className={`compare-progression__slot${ready ? " is-ready" : ""}`}
    aria-label={label}
    aria-busy={state.loading || undefined}
  >
    <h3>{label}</h3>
    {!player && <p role="status">{emptyMessage}</p>}
    {player && state.loading && <p role="status">{loadingMessage}</p>}
    {player && !state.loading && state.error && <p role="alert">{errorMessage}</p>}
    {player && !state.loading && !state.error && !ready && <p role="status">{noHistoryMessage}</p>}
    {ready && <p role="status">{readyMessage}</p>}
  </article>;
}

export default function CompareProgressionSection({
  mode,
  cycleId,
  primary,
  secondary,
}: CompareProgressionSectionProps) {
  const { t } = useI18n();
  const headingId = useId();
  const primaryState = useProgressionTimeline(primary, mode, cycleId);
  const secondaryState = useProgressionTimeline(secondary, mode, cycleId);
  const primaryName = primary ? primary.nickname.trim() || `#${primary.aid}` : "";
  const secondaryName = secondary ? secondary.nickname.trim() || `#${secondary.aid}` : "";
  const primaryReady = Boolean(primary && primaryState.timeline && timelineHasPlayerHistory(primaryState.timeline));
  const secondaryReady = Boolean(secondary && secondaryState.timeline && timelineHasPlayerHistory(secondaryState.timeline));
  const chartKey = `${mode}\0${cycleId}\0${primary?.aid ?? ""}\0${primary?.updatedAt ?? ""}\0${secondary?.aid ?? ""}\0${secondary?.updatedAt ?? ""}`;

  return <section className="profile-page compare-progression surface" aria-labelledby={headingId}>
    <div className="compare-progression__heading">
      <h2 id={headingId} className="section-heading">{t("progression.timeline.title")}</h2>
    </div>
    <div className="compare-progression__slots">
      <TimelineSlot
        label={t("compare.primaryPlayer")}
        player={primary}
        state={primaryState}
        emptyMessage={t("compare.choosePlayer")}
        loadingMessage={t("progression.compare.loading")}
        errorMessage={t("progression.compare.error")}
        noHistoryMessage={t("progression.compare.noHistory")}
        readyMessage={t("progression.ready")}
      />
      <TimelineSlot
        label={t("compare.secondaryPlayer")}
        player={secondary}
        state={secondaryState}
        emptyMessage={t("compare.secondPrompt")}
        loadingMessage={t("progression.compare.loading")}
        errorMessage={t("progression.compare.error")}
        noHistoryMessage={t("progression.compare.noHistory")}
        readyMessage={t("progression.ready")}
      />
    </div>
    {primary && secondary && primaryReady && primaryState.timeline && <div className="compare-progression__chart">
      <ProgressionTimelineChart
        key={chartKey}
        data={primaryState.timeline}
        title={t("progression.timeline.title")}
        variant="compare"
        primaryLabel={primaryName}
        comparisonLabel={secondaryName}
        comparison={secondaryReady && secondaryState.timeline ? {
          aid: secondary.aid,
          nickname: secondaryName,
          timeline: secondaryState.timeline,
        } : undefined}
      />
    </div>}
    <details className="dossier-expand">
      <summary>{t("progression.dataDetails")}</summary>
      <p className="dossier-note">{t("compare.timelineBenchmarkNote")}</p>
      <div className="dossier-pair">
        {[primaryState, secondaryState].map((state, index) => <article className="dossier-cell" key={index}>
          <h3>{index === 0 ? primaryName : secondaryName}</h3>
          {state.timeline ? <TimelineDetails timeline={state.timeline} /> : <p>{t("progression.compare.noHistory")}</p>}
        </article>)}
      </div>
    </details>
  </section>;
}

function TimelineDetails({ timeline }: { timeline: ProgressionTimelineResponse }) {
  const { t, lang } = useI18n();
  const number = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? t("common.notAvailable") : value.toLocaleString(lang, { maximumFractionDigits: digits });
  const definitions: Array<{ field: keyof ProgressionTimelineResponse["longTerm"]; metric?: ProgressionMetricKey; label: string; suffix?: string }> = [
    { field: "survivalRate", metric: "survival", label: "seasonal.metric.survival", suffix: "%" },
    { field: "pvpKd", metric: "pvp_kd", label: "seasonal.metric.pvpKd" },
    { field: "aiKd", metric: "ai_kd", label: "seasonal.metric.aiKd" },
    { field: "overallPmcKd", label: "seasonal.metric.overallPmcKd" },
    { field: "xpPerDay", metric: "xp_per_day", label: "seasonal.metric.xpPerDay" },
    { field: "raidsPerDay", metric: "pmc_raids_per_day", label: "seasonal.metric.raidsPerDay" },
    { field: "pmcKillsPerDay", metric: "pmc_kills_per_day", label: "seasonal.metric.pmcKillsPerDay" },
    { field: "nonPmcKillsPerDay", metric: "non_pmc_kills_per_day", label: "seasonal.metric.nonPmcKillsPerDay" },
    { field: "pmcKillsPerRaid", metric: "pmc_kills_per_raid", label: "seasonal.metric.pmcKillsPerRaid" },
    { field: "nonPmcKillsPerRaid", metric: "non_pmc_kills_per_raid", label: "seasonal.metric.nonPmcKillsPerRaid" },
  ];
  return <>
    <p className="dossier-note">{t("progression.snapshots", { n: timeline.history.snapshotCount })} · {t("progression.intervals", { n: timeline.history.intervalCount })}</p>
    <p className="dossier-note">{t("seasonal.metric.coveredRaids")}: {number(timeline.longTerm?.coveredRaids, 0)}</p>
    <dl className="dossier-timeline-details">{definitions.map(item => {
      const value = timeline.longTerm?.[item.field];
      const median = item.metric ? comparisonTimelineBenchmark(timeline, item.metric) : null;
      return <div key={item.field}><dt>{t(item.label)}</dt><dd>{number(typeof value === "number" ? value : null)}{value != null ? item.suffix : ""}</dd>
        {item.metric && <dd className="dossier-benchmark">{t("compare.playerMedian")}: {number(median?.value)}{median ? item.suffix : ""}{median && ` · ${t(median.population ? "compare.cohortPopulationFallback" : "compare.cohortMatched")} · N=${number(median.n, 0)}`}</dd>}
      </div>;
    })}</dl>
  </>;
}
