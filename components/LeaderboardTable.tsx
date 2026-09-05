"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import type { LeaderboardMeta, LeaderboardRow } from "@/types/leaderboard";

function formatNumber(value: number | null, locale: string, digits = 0): string {
  return value == null
    ? "—"
    : value.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function primaryValue(row: LeaderboardRow, meta: LeaderboardMeta, locale: string): string {
  if (meta.primaryMetric === "arp") return formatNumber(row.stats.arp, locale);
  if (meta.primaryMetric === "killsPerMatch") return formatNumber(row.stats.killsPerMatch, locale, 2);
  return formatNumber(row.score, locale, 2);
}

function primaryRank(row: LeaderboardRow): string {
  if (row.status === "ranked" && row.primaryRank != null) return `#${row.primaryRank}`;
  if (row.status === "insufficient_sample" && row.groupStart != null) return `#${row.groupStart}+`;
  return "—";
}

function RankCell({ row, href }: { row: LeaderboardRow; href: string }) {
  const rank = primaryRank(row);
  return rank === "—" ? rank : <Link href={href} prefetch={false}>{rank}</Link>;
}

export default function LeaderboardTable({
  id,
  title,
  rows,
  meta,
}: {
  id: string;
  title: string;
  rows: LeaderboardRow[];
  meta: LeaderboardMeta;
}) {
  const { lang, t } = useI18n();
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const alternateSort = meta.sort !== "primary";
  const raidLabel = meta.mode === "arena" ? t("leaderboard.column.matches") : t("leaderboard.column.raids");
  const rateLabel = meta.mode === "arena" ? t("leaderboard.column.killsPerMatch") : t("leaderboard.column.killsPerRaid");
  const primaryLabel = meta.primaryMetric === "arp"
    ? t("leaderboard.column.arp")
    : meta.primaryMetric === "killsPerMatch"
      ? t("leaderboard.column.killsPerMatch")
      : t("leaderboard.column.score");

  return (
    <section id={id} tabIndex={-1} className="leaderboard-list data-panel">
      <div className="leaderboard-list__heading">
        <h2 className="section-heading">{title}</h2>
        <span>{t("leaderboard.rows", { n: rows.length.toLocaleString(locale) })}</span>
      </div>
      <div className="leaderboard-table-wrap">
        <table className="leaderboard-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              {alternateSort && <th scope="col">{t("leaderboard.column.position")}</th>}
              <th scope="col">{t("leaderboard.column.rank")}</th>
              <th scope="col" className="leaderboard-table__player">{t("leaderboard.column.player")}</th>
              <th scope="col">{primaryLabel}</th>
              {meta.mode === "arena" && <th scope="col">{t("leaderboard.column.bestArp")}</th>}
              <th scope="col">{t("leaderboard.column.kd")}</th>
              {meta.primaryMetric !== "killsPerMatch" && <th scope="col">{rateLabel}</th>}
              <th scope="col">{raidLabel}</th>
              <th scope="col">{meta.mode === "arena" ? t("leaderboard.column.arenaHours") : t("leaderboard.column.hours")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const focusParams = new URLSearchParams({ mode: meta.mode, sort: "primary", aid: String(row.aid) });
              const profileParams = new URLSearchParams();
              if (meta.mode === "arena" && meta.arenaMode) {
                focusParams.set("arenaMode", meta.arenaMode);
                profileParams.set("arenaMode", meta.arenaMode);
              }
              if (meta.mode === "pvp-season" && meta.cycleId) {
                focusParams.set("cycle", meta.cycleId);
                profileParams.set("cycle", meta.cycleId);
              }
              const profileQuery = profileParams.toString();
              const profileHref = `/player/${meta.mode}/${row.aid}${profileQuery ? `?${profileQuery}` : ""}`;
              return (
                <tr
                  key={row.aid}
                  data-leaderboard-selected={row.selected ? "true" : undefined}
                  aria-current={row.selected ? "true" : undefined}
                  tabIndex={row.selected ? -1 : undefined}
                >
                  {alternateSort && <td className="leaderboard-table__number">{row.position == null ? "—" : `#${row.position}`}</td>}
                  <td className="leaderboard-table__number">
                    <RankCell row={row} href={`/leaderboard?${focusParams}`} />
                  </td>
                  <th scope="row">
                    <Link href={profileHref} prefetch={false}>{row.nickname || `#${row.aid}`}</Link>
                    {row.selected && <span className="sr-only"> {t("leaderboard.selectedPlayer")}</span>}
                  </th>
                  <td className="leaderboard-table__number">{primaryValue(row, meta, locale)}</td>
                  {meta.mode === "arena" && <td className="leaderboard-table__number">{formatNumber(row.stats.bestArp, locale)}</td>}
                  <td className="leaderboard-table__number">
                    {row.stats.deathless ? t("leaderboard.deathless") : formatNumber(row.stats.kd, locale, 2)}
                  </td>
                  {meta.primaryMetric !== "killsPerMatch" && <td className="leaderboard-table__number">{formatNumber(row.stats.killsPerMatch, locale, 2)}</td>}
                  <td className="leaderboard-table__number">{formatNumber(row.stats.raidsOrMatches, locale)}</td>
                  <td className="leaderboard-table__number">{formatNumber(row.stats.hours, locale, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
