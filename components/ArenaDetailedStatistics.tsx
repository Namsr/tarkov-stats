"use client";

import StatCard from "@/components/StatCard";
import { ARENA_METRIC_DECIMALS } from "@/components/arena-ui";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaTsRating } from "@/lib/arena/ts-rating";
import { ARENA_METRIC_KEYS, type ArenaCounters, type ArenaProfile, type ArenaProfileRisk, type ArenaStoredMode } from "@/types/arena";

const GROUPS: Array<{ title: string; rows: Array<[keyof ArenaCounters, string]> }> = [
  { title: "profile.arenaCombat", rows: [["kills", "kills"], ["deaths", "deaths"], ["assists", "assists"], ["headshots", "headshots"], ["damage", "damage"]] },
  { title: "profile.arenaResults", rows: [["matches", "matches"], ["wins", "wins"], ["losses", "losses"], ["round_mvp", "roundMvp"], ["match_mvp", "matchMvp"]] },
  { title: "arena.combat.streaks", rows: [["current_kill_streak", "currentKillStreak"], ["max_kill_streak", "maxKillStreak"], ["current_win_streak", "currentWinStreak"], ["max_win_streak", "maxWinStreak"], ["current_loss_streak", "currentLossStreak"], ["max_loss_streak", "maxLossStreak"]] },
];

export default function ArenaDetailedStatistics({ profile, scope, risk, rating }: {
  profile: ArenaProfile; scope: ArenaStoredMode; risk: ArenaProfileRisk | null; rating: ArenaTsRating | null;
}) {
  const { t, lang } = useI18n();
  const stats = scope === "overall" ? profile.overall : profile.modes[scope];
  const tsr = scope === "overall" ? rating?.overall : rating?.modes[scope];
  const riskScore = (scope === "overall" ? risk?.overall : risk?.modes.find((mode) => mode.mode === scope))?.score ?? null;
  const number = (value: number | null | undefined, digits = 0) => value == null ? t("common.notAvailable") : value.toLocaleString(lang, { maximumFractionDigits: digits });
  const c = stats.counters;
  const inconsistentStreak = (["kill", "win", "loss"] as const).some((type) => {
    const current = c[`current_${type}_streak`], best = c[`max_${type}_streak`];
    return current != null && best != null && current > best;
  });
  return <section id="statistics" tabIndex={-1} className="profile-anchor-section arena-detailed-statistics">
    <div className="profile-collection__heading"><h2 className="section-heading">{t("arena.combat.details")}</h2><span className="profile-scope-name">{t(scope === "overall" ? "profile.allModes" : "arena.mode." + scope)}</span></div>
    <p className="arena-combat-footnote">{t("arena.combat.missing")}</p>
    <div className="profile-statistics">
      {GROUPS.map((group) => <div key={group.title}><h3>{t(group.title)}</h3><div className="data-ledger">{group.rows.map(([key, label]) => <div key={key} data-arena-stat={key}><StatCard label={t("arena.counter." + label)} value={number(c[key])} /></div>)}</div>
        {group.title === "arena.combat.streaks" && inconsistentStreak && <p className="arena-combat-footnote">{t("arena.combat.streakConflict")}</p>}
      </div>)}
      <div><h3>{t("arena.combat.derived")}</h3><div className="data-ledger">{ARENA_METRIC_KEYS.map((key) => <div key={key} data-arena-stat={key}><StatCard label={t("arena.metric." + key)} value={number(stats.metrics[key], ARENA_METRIC_DECIMALS[key])} suffix={stats.metrics[key] != null && (key === "win_rate" || key === "headshot_rate") ? "%" : undefined} /></div>)}</div></div>
      <div><h3>{t("arena.combat.account")}</h3><div className="data-ledger">
        <StatCard label={t("arena.combat.bestArp")} value={number(profile.overall.bestArp)} />
        <StatCard label={t("arena.account.hours")} value={number(profile.overall.hours, 1)} suffix={profile.overall.hours == null ? undefined : t("unit.h")} />
        {scope !== "overall" && <StatCard label={t("arena.combat.modeHours")} value={number(stats.hours, 1)} />}
      </div>{scope !== "overall" && <p className="arena-combat-footnote">{t("arena.combat.modeHoursNote")}</p>}</div>
      <div><h3>{t("arena.combat.ratings")}</h3><div className="data-ledger">
        <StatCard label={t("arena.tsr.title")} value={number(tsr?.displayReady ? tsr.rating : null, 2)} />
        <StatCard label={t("arena.combat.risk")} value={number(riskScore)} suffix={riskScore == null ? undefined : t("arena.combat.outOf100")} />
      </div></div>
    </div>
  </section>;
}
