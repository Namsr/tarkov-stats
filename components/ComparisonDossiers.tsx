"use client";

import Image from "next/image";
import { useId, useMemo, useState, type ReactNode } from "react";
import CheaterScore from "@/components/CheaterScore";
import ProfileRadar from "@/components/ProfileRadar";
import PercentileBadge from "@/components/PercentileBadge";
import { comparisonAdvantage, comparisonDossier, type ComparisonDossier } from "@/lib/comparison-dossier";
import { useI18n } from "@/lib/i18n/context";
import { ARENA_MODE_KEYS } from "@/types/arena";
import type { ComparisonCohort, ComparisonMetricKey, ComparisonPercentile, ComparisonScope } from "@/types/comparison";
import "@/components/comparison-dossiers.css";

interface CohortState { data: ComparisonCohort | null; loading: boolean; error: string }
interface Metric { field: string; label: string; digits?: number; suffix?: string; benchmark?: ComparisonMetricKey; neutral?: boolean }
const persistentMetrics: Metric[] = [
  { field: "kdRatio", label: "metric.kd_ratio", digits: 2, benchmark: "kd_ratio" },
  { field: "pmcKdRatio", label: "metric.pmc_kd_ratio", digits: 2, benchmark: "pmc_kd_ratio" },
  { field: "killedPmcPerRaid", label: "seasonal.metric.pmcKillsPerRaid", digits: 2 },
  { field: "killsPerRaid", label: "metric.kills_per_raid", digits: 2, benchmark: "kills_per_raid" },
  { field: "pmcSurvivalRate", label: "metric.pmc_survival_rate", digits: 1, suffix: "%", benchmark: "pmc_survival_rate" },
  { field: "survivalRate", label: "player.survivalRate", digits: 1, suffix: "%" },
  { field: "longestWinStreak", label: "metric.longest_win_streak", benchmark: "longest_win_streak" },
];
const activityMetrics: Metric[] = [
  { field: "hours", label: "player.hoursPlayed", digits: 1 },
  { field: "totalRaids", label: "player.totalRaids" }, { field: "pmcRaids", label: "player.pmcRaids" },
  { field: "scavRaids", label: "player.scavRaids" }, { field: "totalKills", label: "player.totalKills" },
  { field: "pmcAllKills", label: "compare.pmcAllKills" }, { field: "killedPmc", label: "player.pmcKills" },
  { field: "survivedRaids", label: "compare.survivedRaids" }, { field: "pmcSurvived", label: "compare.pmcSurvived" },
  { field: "deaths", label: "player.deaths" }, { field: "pmcDeaths", label: "compare.pmcDeaths" },
  { field: "runThrough", label: "player.runThroughs" },
  { field: "pmcExitKilled", label: "player.outcome.killed" }, { field: "pmcExitLeft", label: "player.outcome.left" },
  { field: "pmcExitTransit", label: "player.outcome.transit" }, { field: "pmcExitMia", label: "player.outcome.mia" },
];
const progressionMetrics: Metric[] = [
  { field: "level", label: "player.level", benchmark: "level" }, { field: "prestige", label: "player.prestige" },
  { field: "experience", label: "player.experience" }, { field: "achievementsCount", label: "player.achievements" },
];
const arenaMetrics: Metric[] = [
  { field: "arena_overall_kd_ratio", label: "arena.metric.kd_ratio", digits: 2, benchmark: "kd_ratio" },
  { field: "arena_overall_win_rate", label: "arena.metric.win_rate", digits: 1, suffix: "%", benchmark: "win_rate" },
  { field: "arena_overall_headshot_rate", label: "arena.metric.headshot_rate", digits: 1, suffix: "%", benchmark: "headshot_rate" },
  { field: "arena_overall_kills_per_match", label: "arena.metric.kills_per_match", digits: 2, benchmark: "kills_per_match" },
  { field: "arena_overall_damage_per_match", label: "arena.metric.damage_per_match", benchmark: "damage_per_match" },
  { field: "tsRating", label: "arena.tsr.title", digits: 2 },
];
const arenaCounters = [
  ["matches", "matches"], ["wins", "wins"], ["losses", "losses"], ["kills", "kills"], ["deaths", "deaths"],
  ["assists", "assists"], ["headshots", "headshots"], ["damage", "damage"], ["round_mvp", "roundMvp"], ["match_mvp", "matchMvp"],
  ["current_kill_streak", "currentKillStreak"], ["max_kill_streak", "maxKillStreak"],
  ["current_win_streak", "currentWinStreak"], ["max_win_streak", "maxWinStreak"],
  ["current_loss_streak", "currentLossStreak"], ["max_loss_streak", "maxLossStreak"],
] as const;

export default function ComparisonDossiers({ scope, primaryAid, secondaryAid, primaryPayload, secondaryPayload, cohorts, progression }: {
  scope: ComparisonScope; primaryAid: number | null; secondaryAid: number | null;
  primaryPayload: unknown; secondaryPayload: unknown; cohorts: readonly [CohortState, CohortState]; progression: ReactNode;
}) {
  const { t, lang } = useI18n();
  const sectionPrefix = useId();
  const players = useMemo(() => [
    primaryAid === null ? null : comparisonDossier(scope, primaryAid, primaryPayload),
    secondaryAid === null ? null : comparisonDossier(scope, secondaryAid, secondaryPayload),
  ] as const, [scope, primaryAid, secondaryAid, primaryPayload, secondaryPayload]);
  const [differentAchievements, setDifferentAchievements] = useState(false);
  const [showZeroMastery, setShowZeroMastery] = useState(false);
  const number = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? t("common.notAvailable") : value.toLocaleString(lang, { maximumFractionDigits: digits });
  const date = (value: number | null) => value == null ? t("achievement.dateUnavailable") : new Date(value).toLocaleDateString(lang, { timeZone: "Europe/Moscow" });
  const name = (index: number) => players[index]?.nickname ?? t(index === 0 ? "compare.primaryPlayer" : "compare.secondaryPlayer");
  const value = (index: number, field: string) => players[index]?.values[field] ?? null;
  function advantage(values: readonly [number | null, number | null], index: number, neutral = false) {
    const result = neutral ? null : comparisonAdvantage(...values);
    if (result?.winner !== index) return null;
    const plural = result.ratio !== null ? new Intl.PluralRules(lang, { maximumFractionDigits: 2 }).select(result.ratio) : null;
    return <span className="dossier-advantage">↑ {result.ratio !== null
      ? t(plural === "one" || plural === "many" ? "compare.higherTimesWhole" : "compare.higherTimes", { n: number(result.ratio, 2) })
      : t("compare.moreBy", { n: number(result.difference, 2) })}</span>;
  }
  function benchmark(index: number, metric: Metric) {
    if (!metric.benchmark || !players[index]) return null;
    const state = cohorts[index];
    const benchmarks = state.data?.benchmarks as Partial<Record<ComparisonMetricKey, { value: number | null; count: number }>> | undefined;
    const median = state.data?.quality === "sufficient" ? benchmarks?.[metric.benchmark] : null;
    return <span className="dossier-benchmark">{t("compare.playerMedian")}: {state.loading ? t("common.loading") : number(median && median.count > 0 ? median.value : null, metric.digits)}{median?.value != null ? metric.suffix : ""}</span>;
  }
  function metricPairs(metrics: readonly Metric[], neutral = false) {
    return <div className="dossier-metrics">{metrics.map(metric => {
      const values = [value(0, metric.field), value(1, metric.field)] as const;
      return <div className="dossier-pair" key={metric.field} data-compare-metric={metric.field}>{players.map((player, index) => {
        const lead = advantage(values, index, neutral || metric.neutral);
        const percentiles = cohorts[index].data?.percentiles as Partial<Record<ComparisonMetricKey, ComparisonPercentile>> | null | undefined;
        const percentile = metric.benchmark ? percentiles?.[metric.benchmark] : null;
        return <article key={index} className={`dossier-cell${lead ? " is-ahead" : ""}`} aria-label={`${name(index)}: ${t(metric.label)}`}>
          <span className="dossier-label">{t(metric.label)}</span>
          <strong className="dossier-value">{number(values[index], metric.digits)}{values[index] !== null ? metric.suffix : ""}</strong>
          {lead}{benchmark(index, metric)}
          {player && percentile && <PercentileBadge percentile={percentile.percentile} />}
        </article>;
      })}</div>;
    })}</div>;
  }
  function section(id: string, title: string, children: ReactNode, note?: string) {
    return <section id={`compare-${id}`} className="dossier-section" aria-labelledby={`${sectionPrefix}-${id}`}>
      <h2 id={`${sectionPrefix}-${id}`} className="section-heading">{t(title)}</h2>
      {note && <p className="dossier-note">{t(note)}</p>}{children}
    </section>;
  }
  function collection(id: string, rows: ReactNode[], limit: number) {
    return <><div className="dossier-metrics">{rows.slice(0, limit)}</div>{rows.length > limit && <details className="dossier-expand" key={`${id}:${scope.mode}:${primaryAid}:${secondaryAid}`}>
      <summary>{t("compare.showCollection", { n: rows.length })}</summary><div className="dossier-metrics">{rows.slice(limit)}</div>
    </details>}</>;
  }
  const achievements = [...new Map(players.flatMap(player => player?.achievements ?? []).map(item => [item.id, item])).values()]
    .filter(item => !differentAchievements || players[0]?.achievements.some(row => row.id === item.id) !== players[1]?.achievements.some(row => row.id === item.id))
    .sort((left, right) => (left.percentage ?? 100) - (right.percentage ?? 100));
  const achievementRows = achievements.map(item => {
    const title = lang === "ru" ? item.nameRu ?? item.name : item.name;
    const description = lang === "ru" ? item.descriptionRu ?? item.description : item.description;
    const owned = players.map(player => player?.achievements.find(row => row.id === item.id));
    return <div className="dossier-pair" key={item.id} data-compare-achievement={item.id}>{players.map((player, index) => <article className={`dossier-cell dossier-achievement${owned[index] && !owned[1-index] ? " is-ahead" : ""}`} key={index}>
      <div className="dossier-item-heading">{item.imageUrl && <Image src={item.imageUrl} alt="" width={40} height={40} unoptimized onError={event => { event.currentTarget.style.visibility = "hidden"; }} />}<h3>{title}</h3></div>
      <p className="dossier-note">{description ?? t("achievement.descriptionUnavailable")}</p>
      <strong>{!player ? t("common.notAvailable") : owned[index] ? t("compare.achievementOwned") : t("compare.achievementMissing")}</strong>
      {owned[index] && <time dateTime={owned[index].unlockedAt == null ? undefined : new Date(owned[index].unlockedAt).toISOString()}>{date(owned[index].unlockedAt)}</time>}
      <span className="dossier-benchmark">{t("achievement.col.rarity")}: {item.rarity && ["common", "uncommon", "rare", "epic", "legendary", "seasonal"].includes(item.rarity) ? t("achievement.rarity." + item.rarity) : t("common.notAvailable")}</span>
      <span className="dossier-benchmark">{t("achievement.col.percent")}: {number(item.percentage, 1)}{item.percentage !== null ? "%" : ""} · {t("compare.official")}: {number(item.officialPercentage, 1)}{item.officialPercentage !== null ? "%" : ""}</span>
    </article>)}</div>;
  });
  const skillIds = [...new Set(players.flatMap(player => player?.skills.map(item => item.id) ?? []))]
    .sort((left, right) => Math.max(...players.map(player => player?.skills.find(item => item.id === right)?.progress ?? 0)) - Math.max(...players.map(player => player?.skills.find(item => item.id === left)?.progress ?? 0)));
  const skillRows = skillIds.map(id => {
    const skills = players.map(player => player?.skills.find(item => item.id === id));
    const points = skills.map(skill => skill ? Math.min(skill.progress, 5100) : null) as [number | null, number | null];
    return <div className="dossier-pair" key={id} data-compare-skill={id}>{skills.map((skill, index) => <article key={index} className={`dossier-cell${comparisonAdvantage(...points)?.winner === index ? " is-ahead" : ""}`}>
      <div className="dossier-item-heading"><Image src={`https://assets.tarkov.dev/skill-${id}-icon.webp`} alt="" width={30} height={30} unoptimized onError={event => { event.currentTarget.style.visibility = "hidden"; }} /><h3>{t("skill." + id)}</h3></div>
      <strong className="dossier-value">{skill ? skill.elite ? t("profile.skillElite") : t("profile.skillLevel", { n: skill.level }) : t("common.notAvailable")}</strong>
      {advantage(points, index)}
      {skill && <div className="dossier-skill-progress"><progress max={5100} value={Math.min(skill.progress, 5100)} aria-label={`${t("skill." + id)}: ${skill.elite ? t("profile.skillElite") : t("profile.skillLevel", { n: skill.level })}`} /><span>{skill.elite ? t("profile.skillElite") : t("compare.skillLevelProgress", { n: number(skill.percent, 1) })}</span></div>}
    </article>)}</div>;
  });
  const masteryIds = [...new Set(players.flatMap(player => player?.mastery.map(item => item.id) ?? []))]
    .filter(id => showZeroMastery || players.some(player => Math.round(player?.mastery.find(item => item.id === id)?.progress ?? 0) > 0))
    .sort((left, right) => Math.max(...players.map(player => player?.mastery.find(item => item.id === right)?.progress ?? 0)) - Math.max(...players.map(player => player?.mastery.find(item => item.id === left)?.progress ?? 0)));
  const masteryRows = masteryIds.map(id => {
    const items = players.map(player => player?.mastery.find(item => item.id === id));
    const points = items.map(item => item ? Math.round(item.progress) : null) as [number | null, number | null];
    return <div className="dossier-pair" key={id} data-compare-mastery={id}>{items.map((item, index) => <article key={index} className={`dossier-cell${comparisonAdvantage(...points)?.winner === index ? " is-ahead" : ""}`}>
      <span className="dossier-label">{item?.weapon ?? id}</span><strong className="dossier-value">{number(points[index])}</strong>
      <span className="dossier-benchmark">{item ? t("profile.skillLevel", { n: item.level }) : t("common.notAvailable")}</span>{advantage(points, index)}
    </article>)}</div>;
  });
  function radar(player: ComparisonDossier, index: number) {
    const metrics = (scope.mode === "arena" ? arenaMetrics : [...persistentMetrics, progressionMetrics[0]])
      .filter(metric => metric.benchmark).map(metric => {
        const benchmarks = cohorts[index].data?.benchmarks as Partial<Record<ComparisonMetricKey, { value: number | null; count: number }>> | undefined;
        const base = cohorts[index].data?.quality === "sufficient" ? benchmarks?.[metric.benchmark!]?.value ?? null : null;
        return { key: metric.field, label: t(metric.label), a: player.values[metric.field] ?? null, b: base, baseline: base, digits: metric.digits ?? 0, percent: metric.suffix === "%" };
      });
    return <div className="dossier-radar-scroll" tabIndex={0} role="region" aria-label={t("radar.title")}><div className="dossier-radar-canvas">
      <ProfileRadar metrics={metrics} playerName={player.nickname} otherName={t("compare.playerMedian")} />
    </div></div>;
  }
  const sectionLinks = [
    ["combat", "compare.combat"], ["activity", "compare.activity"], ...(scope.mode === "arena" ? [] : [["growth", "compare.growth"], ["progression", "profile.section.progression"]]),
    ["comparison", "profile.section.comparison"], ["risk", "profile.section.risk"],
    ...(scope.mode === "arena" ? [["arena-modes", "profile.allModes"]] : [["achievements", "profile.section.achievements"], ["skills", "profile.section.skills"], ["mastering", "profile.section.mastering"]]),
  ];
  if (!players.some(Boolean)) return null;
  return <div className="comparison-dossiers profile-page">
    <nav className="dossier-nav" aria-label={t("profile.sectionNav")}>{sectionLinks.map(([id, label]) => <a key={id} href={`#compare-${id}`}>{t(label)}</a>)}</nav>
    <div className="dossier-strip">{players.map((_, index) => <span key={index}>{name(index)}</span>)}</div>
    {section("combat", "compare.combat", metricPairs(scope.mode === "arena" ? arenaMetrics : persistentMetrics), "compare.advantageNote")}
    {section("activity", "compare.activity", metricPairs(scope.mode === "arena" ? [
      { field: "hours", label: "arena.account.hours", digits: 1 }, { field: "bestArp", label: "arena.combat.bestArp" },
      ...arenaCounters.map(([key, label]) => ({ field: `arena_overall_${key}`, label: `arena.counter.${label}` })),
    ] : activityMetrics.filter(metric => scope.mode !== "seasonal" || !metric.field.startsWith("pmcExit")), true), "compare.activityNote")}
    {scope.mode !== "arena" && section("growth", "compare.growth", metricPairs(progressionMetrics))}
    {scope.mode !== "arena" && section("progression", "profile.section.progression", progression)}
    {section("comparison", "profile.section.comparison", <>
      <p className="dossier-note">{t("compare.separateBenchmarks")}</p><div className="dossier-pair dossier-cohorts">{players.map((player, index) => <article className="dossier-cell" key={index}>
        <h3>{name(index)}</h3>{cohorts[index].loading && <p role="status">{t("compare.cohortLoading")}</p>}
        {cohorts[index].error && <p role="alert">{cohorts[index].error}</p>}
        {cohorts[index].data?.quality === "sufficient" ? <>
          <p className="dossier-note">{t(cohorts[index].data?.strategy === "population" ? "compare.cohortPopulationFallback" : "compare.cohortMatched")}</p>
          <p>{t("compare.cohortSize")}: {number(cohorts[index].data?.n)}</p>
          {cohorts[index].data?.strategy === "population" && <p className="dossier-note">{t("compare.cohortFallbackNote")}</p>}
          {player && radar(player, index)}
        </> : !cohorts[index].loading && !cohorts[index].error && <p role="status">{t("compare.cohortUnavailable")}</p>}
      </article>)}</div>
    </>)}
    {section("risk", "profile.section.risk", <div className="dossier-pair">{players.map((player, index) => <article className="dossier-cell profile-risk" key={index}>
      <h3>{name(index)}</h3><div className="profile-risk__reading"><CheaterScore compact risk={player?.risk ?? null} mode={scope.mode} cycleId={scope.cycleId} /><p>{t("cheater.disclaimer")}</p></div>
    </article>)}</div>)}
    {scope.mode === "arena" ? section("arena-modes", "profile.allModes", <div className="dossier-arena-modes">{ARENA_MODE_KEYS.map(mode => <details key={mode}>
      <summary>{t("arena.mode." + mode)}</summary>{metricPairs([
        ...arenaMetrics.filter(metric => metric.benchmark).map(metric => ({ ...metric, field: metric.field.replace("overall", mode), benchmark: undefined })),
        ...arenaCounters.map(([key, label]) => ({ field: `arena_${mode}_${key}`, label: `arena.counter.${label}`, neutral: true })),
      ])}
    </details>)}</div>) : <>
      {section("achievements", "profile.section.achievements", <>
        <label className="dossier-filter"><input type="checkbox" checked={differentAchievements} onChange={event => setDifferentAchievements(event.target.checked)} />{t("compare.onlyDifferentAchievements")}</label>
        {achievementRows.length ? collection("achievements", achievementRows, 5) : <p className="dossier-note">{t("common.notAvailable")}</p>}
      </>)}
      {section("skills", "profile.section.skills", skillRows.length ? collection("skills", skillRows, 6) : <p className="dossier-note">{t("common.notAvailable")}</p>)}
      {section("mastering", "profile.section.mastering", <><label className="dossier-filter"><input type="checkbox" checked={showZeroMastery} onChange={event => setShowZeroMastery(event.target.checked)} />{t("compare.showZeroMastery")}</label>
        {masteryRows.length ? collection("mastery", masteryRows, 6) : <p className="dossier-note">{t("common.notAvailable")}</p>}
      </>)}
    </>}
  </div>;
}
