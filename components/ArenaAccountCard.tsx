"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import StatCard from "@/components/StatCard";
import { arenaMetricValue, formatArenaMetric, formatArenaValue } from "@/components/arena-ui";
import type { ArenaProfile } from "@/types/arena";

export default function ArenaAccountCard({ profile }: { profile: ArenaProfile }) {
  const { t } = useI18n();
  const overall = profile.overall;
  const counters = overall.counters;
  const legacy = profile.parserVersion === 0;
  const winRate = arenaMetricValue(overall, "win_rate");
  return (
    <div>
      {legacy && <p className="mb-3 text-sm text-[var(--muted)]">{t("arena.profile.legacyIncomplete")}</p>}
      <div className="detail-grid">
        <StatCard label={t("arena.account.hours")} value={overall.hours == null ? t("common.notAvailable") : Math.round(overall.hours).toLocaleString()} suffix={overall.hours == null ? undefined : t("unit.h")} />
        <StatCard label={t("arena.counter.matches")} value={counters.matches == null ? t("common.notAvailable") : counters.matches.toLocaleString()} />
        <StatCard label={t("arena.counter.kills")} value={counters.kills == null ? t("common.notAvailable") : counters.kills.toLocaleString()} />
        <StatCard label={t("arena.metric.win_rate")} value={formatArenaMetric(winRate, "win_rate")} />
        <div className="metric-card flex flex-col gap-2">
          <span className="metric-card__label">{t("arena.bestArp")}</span>
          <div className="flex items-end gap-2">
            <span className="metric-card__value">
              {overall.bestArp == null ? (
                t("common.notAvailable")
              ) : (
                <Link
                  href="/average/arena/leaderboard"
                  className="underline-offset-4 hover:underline"
                  aria-label={t("arena.leaderboard.openFull")}
                >
                  {formatArenaValue(overall.bestArp)}
                </Link>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
