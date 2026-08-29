"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import type { Favorite } from "@/lib/db";
import type { ParsedPlayerStats } from "@/types/tarkov";
import { favoriteHref, favoriteKey } from "@/lib/favorites/identity";
import {
  ARENA_METRIC_KEYS,
  ARENA_MODE_KEYS,
  formatArenaMetric,
  isArenaProfile,
  type ArenaCardStats,
} from "@/components/arena-ui";
import type { ArenaModeStats, ArenaProfile } from "@/types/arena";

interface Props {
  favorites: Favorite[];
  statsByFavorite: Map<string, ArenaCardStats>;
}

interface MetricDef {
  key: string;
  labelKey: string;
  get: (s: ParsedPlayerStats) => number;
  suffix?: string;
  dec: number;
}

type CompareMode = Extract<Favorite["mode"], "regular" | "pve">;

const COMPARE_MODES = ["regular", "pve"] as const satisfies readonly CompareMode[];
const MODE_LABEL_KEYS: Record<CompareMode, string> = {
  regular: "fav.mode.regular",
  pve: "fav.mode.pve",
};

interface CompareColumn {
  fav: Favorite;
  stats: ParsedPlayerStats;
}

interface ArenaCompareColumn {
  fav: Favorite;
  profile: ArenaProfile;
}

// All metrics here are higher-is-better, so the row max is the winner. Labels
// reuse the existing compare.* dictionary keys.
const METRICS: MetricDef[] = [
  { key: "kd", labelKey: "compare.kdRatio", get: (s) => s.kdRatio, dec: 2 },
  { key: "surv", labelKey: "compare.survivalRate", get: (s) => s.survivalRate, suffix: "%", dec: 1 },
  { key: "kpr", labelKey: "compare.killsPerRaid", get: (s) => s.killsPerRaid, dec: 2 },
  { key: "kills", labelKey: "compare.totalKills", get: (s) => s.totalKills, dec: 0 },
  { key: "raids", labelKey: "compare.totalRaids", get: (s) => s.totalRaids, dec: 0 },
  { key: "hours", labelKey: "compare.hoursPlayed", get: (s) => s.hoursPlayed, dec: 0 },
  { key: "streak", labelKey: "compare.winStreak", get: (s) => s.longestWinStreak, dec: 0 },
  { key: "level", labelKey: "compare.level", get: (s) => s.level, dec: 0 },
  { key: "achv", labelKey: "compare.achievements", get: (s) => s.achievementsCount, dec: 0 },
];

function fmt(v: number, dec: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function ComparisonTable({ mode, cols }: { mode: CompareMode; cols: CompareColumn[] }) {
  const { t } = useI18n();

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted-strong)]">
        {t(MODE_LABEL_KEYS[mode])}
      </h3>
      <div className="overflow-x-auto border border-[var(--card-border)] rounded-xl">
        <table className="w-full border-collapse min-w-[28rem]">
          <thead>
            <tr className="border-b border-[var(--card-border)]">
              <th className="py-3 px-3 text-left text-xs uppercase tracking-wider text-[var(--muted)]">
                {t("cmp.metric")}
              </th>
              {cols.map((c) => (
                <th
                  key={favoriteKey(c.fav)}
                  className="py-3 px-3 text-right text-xs uppercase tracking-wider text-[var(--accent)]"
                >
                  <Link href={favoriteHref(c.fav)} className="hover:underline">
                    {c.stats.nickname}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => {
              const values = cols.map((c) => m.get(c.stats));
              const best = Math.max(...values);
              const allEqual = values.every((v) => v === best);
              return (
                <tr
                  key={m.key}
                  className="border-b border-[var(--card-border)]/70 hover:bg-[var(--input-bg)] transition-colors"
                >
                  <td className="py-3 px-3 text-sm text-[var(--muted-strong)]">{t(m.labelKey)}</td>
                  {cols.map((c, i) => {
                    const v = values[i];
                    const isBest = !allEqual && v === best;
                    return (
                      <td
                        key={favoriteKey(c.fav)}
                        className={`py-3 px-3 text-right font-medium ${
                          isBest ? "text-[var(--success)]" : "text-[var(--muted-strong)]"
                        }`}
                      >
                        {fmt(v, m.dec)}
                        {m.suffix ?? ""}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ArenaComparisonTable({ mode, cols }: { mode: ArenaModeStats["mode"]; cols: ArenaCompareColumn[] }) {
  const { t } = useI18n();
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted-strong)]">
        {t("arena.mode." + mode)}
      </h3>
      <div className="overflow-x-auto rounded-xl border border-[var(--card-border)]">
        <table className="w-full min-w-[32rem] border-collapse">
          <thead>
            <tr className="border-b border-[var(--card-border)]">
              <th scope="col" className="px-3 py-3 text-left text-xs uppercase tracking-wider text-[var(--muted)]">{t("arena.radar.metric")}</th>
              {cols.map(({ fav, profile }) => (
                <th key={favoriteKey(fav)} scope="col" className="px-3 py-3 text-right text-xs uppercase tracking-wider text-[var(--accent)]">
                  <Link href={favoriteHref(fav)} className="hover:underline">{profile.nickname || `#${fav.aid}`}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ARENA_METRIC_KEYS.map((metric) => {
              const values = cols.map(({ profile }) => profile.modes[mode].metrics[metric]);
              const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
              const best = finite.length > 0 ? Math.max(...finite) : null;
              return (
                <tr key={metric} className="border-b border-[var(--card-border)]/70 transition-colors hover:bg-[var(--input-bg)]">
                  <th scope="row" className="px-3 py-3 text-left text-sm text-[var(--muted-strong)]">{t("arena.metric." + metric)}</th>
                  {values.map((value, index) => (
                    <td key={favoriteKey(cols[index].fav)} className={`px-3 py-3 text-right font-medium ${best !== null && value === best ? "text-[var(--success)]" : "text-[var(--muted-strong)]"}`}>
                      {value === null ? t("common.notAvailable") : formatArenaMetric(value, metric)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function FavoritesCompare({ favorites, statsByFavorite }: Props) {
  const { t } = useI18n();
  const groups = COMPARE_MODES.map((mode) => ({
    mode,
    cols: favorites
      .filter((favorite) => favorite.mode === mode)
      .map((favorite) => ({ fav: favorite, stats: statsByFavorite.get(favoriteKey(favorite)) ?? null }))
      .filter((c): c is CompareColumn => c.stats !== null),
  }));
  const arenaGroups = ARENA_MODE_KEYS.map((mode) => ({
    mode,
    cols: favorites
      .filter((favorite) => favorite.mode === "arena")
      .map((favorite) => ({
        fav: favorite,
        profile: isArenaProfile(statsByFavorite.get(favoriteKey(favorite)))
          ? statsByFavorite.get(favoriteKey(favorite)) as ArenaProfile
          : null,
      }))
      .filter((column): column is ArenaCompareColumn => column.profile !== null),
  }));
  const visibleGroups = groups.filter((group) => group.cols.length > 0);
  const comparableGroups = visibleGroups.filter((group) => group.cols.length >= 2);
  const visibleArenaGroups = arenaGroups.filter((group) => group.cols.length > 0);
  const comparableArenaGroups = visibleArenaGroups.filter((group) => group.cols.length >= 2);

  if (visibleGroups.length === 0 && visibleArenaGroups.length === 0) {
    return <p className="text-sm text-[var(--muted)]">{t("profile.compareNeedTwo")}</p>;
  }

  return (
    <div className="space-y-6">
      {comparableGroups.map((group) => (
        <ComparisonTable key={group.mode} mode={group.mode} cols={group.cols} />
      ))}
      {comparableArenaGroups.map((group) => (
        <ArenaComparisonTable key={group.mode} mode={group.mode} cols={group.cols} />
      ))}
      {visibleGroups
        .filter((group) => group.cols.length < 2)
        .map((group) => (
          <p key={group.mode} className="text-sm text-[var(--muted)]">
            {t("profile.compareNeedTwo")} ({t(MODE_LABEL_KEYS[group.mode])})
          </p>
        ))}
      {visibleArenaGroups
        .filter((group) => group.cols.length < 2)
        .map((group) => (
          <p key={group.mode} className="text-sm text-[var(--muted)]">
            {t("profile.compareNeedTwo")} ({t("arena.mode." + group.mode)})
          </p>
        ))}
    </div>
  );
}
