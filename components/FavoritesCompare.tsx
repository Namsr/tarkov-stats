"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import type { Favorite } from "@/lib/db";
import type { ParsedPlayerStats } from "@/types/tarkov";

interface Props {
  favorites: Favorite[];
  statsByAid: Map<number, ParsedPlayerStats | null>;
}

interface MetricDef {
  key: string;
  labelKey: string;
  get: (s: ParsedPlayerStats) => number;
  suffix?: string;
  dec: number;
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

export default function FavoritesCompare({ favorites, statsByAid }: Props) {
  const { t } = useI18n();

  // Only accounts whose public profile actually loaded can be compared.
  const cols = favorites
    .map((f) => ({ fav: f, stats: statsByAid.get(f.aid) ?? null }))
    .filter((c): c is { fav: Favorite; stats: ParsedPlayerStats } => c.stats !== null);

  if (cols.length < 2) {
    return <p className="text-sm text-gray-500">{t("profile.compareNeedTwo")}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse min-w-[28rem]">
        <thead>
          <tr className="border-b border-[var(--card-border)]">
            <th className="py-3 px-3 text-left text-xs uppercase tracking-wider text-gray-500">
              {t("cmp.metric")}
            </th>
            {cols.map((c) => (
              <th
                key={c.fav.aid}
                className="py-3 px-3 text-right text-xs uppercase tracking-wider text-[var(--accent)]"
              >
                <Link href={`/player/${c.fav.aid}`} className="hover:underline">
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
                className="border-b border-[var(--card-border)]/50 hover:bg-[var(--card-border)]/20 transition-colors"
              >
                <td className="py-3 px-3 text-sm text-gray-400">{t(m.labelKey)}</td>
                {cols.map((c, i) => {
                  const v = values[i];
                  const isBest = !allEqual && v === best;
                  return (
                    <td
                      key={c.fav.aid}
                      className={`py-3 px-3 text-right font-medium ${
                        isBest ? "text-[var(--success)]" : "text-gray-300"
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
  );
}
