"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useLayoutEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { LeaderboardMeta, LeaderboardRow, LeaderboardSort } from "@/types/leaderboard";

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

function displayRank(row: LeaderboardRow, sort: LeaderboardSort): string {
  if (row.status === "insufficient_sample" && row.groupStart != null) return `#${row.groupStart}+`;
  // Place always follows the active filter: primary rank for Балл, position otherwise.
  const rank = sort === "primary" ? row.primaryRank : row.position;
  if (row.status === "ranked" && rank != null) return `#${rank}`;
  return "—";
}

function RankCell({ row, sort, href }: { row: LeaderboardRow; sort: LeaderboardSort; href: string }) {
  const rank = displayRank(row, sort);
  return rank === "—" ? rank : <Link href={href} prefetch={false}>{rank}</Link>;
}

// FLIP: rows glide to their new positions on resort instead of swapping instantly.
// Measures offsetTop per aid before paint, then animates the delta. Skipped entirely
// under prefers-reduced-motion. Runs on every render; unchanged rows are no-ops.
function flipRows(container: HTMLElement | null, prev: Map<number, number>): Map<number, number> {
  const current = new Map<number, number>();
  if (!container) return current;
  container.querySelectorAll("[data-aid]").forEach((el) => {
    current.set(Number((el as HTMLElement).dataset.aid), (el as HTMLElement).offsetTop);
  });
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    current.forEach((top, aid) => {
      const from = prev.get(aid);
      if (from == null || from === top) return;
      container.querySelector(`[data-aid="${aid}"]`)?.animate(
        [{ transform: `translateY(${from - top}px)` }, { transform: "translateY(0)" }],
        { duration: 340, easing: "cubic-bezier(.22,1,.36,1)" },
      );
    });
  }
  return current;
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
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const cardsRef = useRef<HTMLOListElement>(null);
  const flipPrev = useRef({ tbody: new Map<number, number>(), cards: new Map<number, number>() });
  useLayoutEffect(() => {
    flipPrev.current.tbody = flipRows(tbodyRef.current, flipPrev.current.tbody);
    flipPrev.current.cards = flipRows(cardsRef.current, flipPrev.current.cards);
  });
  // Upstream exposes only Best ARP — there is no current ARP data.
  // Hide the primary ARP column for BlastGang and keep BEST ARP as the rating.
  // BEST ARP is shown only for BlastGang; other Arena modes keep arena numbers.
  const hidePrimaryArp = meta.mode === "arena" && meta.primaryMetric === "arp";
  const showBestArp = meta.mode === "arena" && meta.arenaMode === "blastGang";
  const rateLabel = meta.mode === "arena" ? t("leaderboard.column.killsPerMatch") : t("leaderboard.column.killsPerRaid");
  const killsLabel = meta.mode === "arena" ? t("leaderboard.column.arenaKills") : t("leaderboard.column.kills");
  const primaryLabel = meta.primaryMetric === "arp"
    ? t("leaderboard.column.bestArp")
    : meta.primaryMetric === "killsPerMatch"
      ? t("leaderboard.column.killsPerMatch")
      : t("leaderboard.column.score");

  return (
    <section id={id} tabIndex={-1} className="leaderboard-list data-panel">
      <div className="leaderboard-list__heading">
        <h2 className="section-heading">{title}</h2>
        <span>{t("leaderboard.total", { n: meta.rankedCount.toLocaleString(locale) })}</span>
      </div>
      <div className="leaderboard-table-wrap">
        <table className="leaderboard-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{t("leaderboard.column.rank")}</th>
              <th scope="col" className="leaderboard-table__player">{t("leaderboard.column.player")}</th>
              {!hidePrimaryArp && <th scope="col">{primaryLabel}</th>}
              {showBestArp && <th scope="col">{t("leaderboard.column.bestArp")}</th>}
              <th scope="col">{t("leaderboard.column.kd")}</th>
              {meta.primaryMetric !== "killsPerMatch" && <th scope="col">{rateLabel}</th>}
              <th scope="col">{killsLabel}</th>
              <th scope="col">{t("leaderboard.column.hours")}</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {rows.map((row, index) => {
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
                  data-aid={row.aid}
                  style={{ "--lb-i": index } as CSSProperties}
                  data-leaderboard-selected={row.selected ? "true" : undefined}
                  aria-current={row.selected ? "true" : undefined}
                  tabIndex={row.selected ? -1 : undefined}
                >
                  <td className="leaderboard-table__number">
                    <RankCell row={row} sort={meta.sort} href={`/leaderboard?${focusParams}`} />
                  </td>
                  <th scope="row">
                    <Link href={profileHref} prefetch={false}>{row.nickname || `#${row.aid}`}</Link>
                    {row.selected && <span className="sr-only"> {t("leaderboard.selectedPlayer")}</span>}
                  </th>
                  {!hidePrimaryArp && <td className="leaderboard-table__number">{primaryValue(row, meta, locale)}</td>}
                  {showBestArp && <td className="leaderboard-table__number">{formatNumber(row.stats.bestArp, locale)}</td>}
                  <td className="leaderboard-table__number">
                    {row.stats.deathless ? formatNumber(row.stats.kills, locale) : formatNumber(row.stats.kd, locale, 2)}
                  </td>
                  {meta.primaryMetric !== "killsPerMatch" && <td className="leaderboard-table__number">{formatNumber(row.stats.killsPerMatch, locale, 2)}</td>}
                  <td className="leaderboard-table__number">{formatNumber(row.stats.kills, locale)}</td>
                  <td className="leaderboard-table__number">{formatNumber(row.stats.hours, locale, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ol ref={cardsRef} className="leaderboard-cards">
        {rows.map((row, index) => {
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
          const rank = displayRank(row, meta.sort);
          return (
            <li
              key={row.aid}
              data-aid={row.aid}
              style={{ "--lb-i": index } as CSSProperties}
              className="leaderboard-card"
              data-leaderboard-selected={row.selected ? "true" : undefined}
              aria-current={row.selected ? "true" : undefined}
            >
              <div className="leaderboard-card__top">
                <Link href={profileHref} prefetch={false} className="leaderboard-card__name">
                  {row.nickname || `#${row.aid}`}
                </Link>
                {row.selected && <span className="sr-only"> {t("leaderboard.selectedPlayer")}</span>}
                <span className="leaderboard-card__rank">
                  {rank === "—" ? rank : <Link href={`/leaderboard?${focusParams}`} prefetch={false}>{rank}</Link>}
                </span>
              </div>
              <dl className="leaderboard-card__grid">
                {!hidePrimaryArp && (
                  <div>
                    <dt>{primaryLabel}</dt>
                    <dd>{primaryValue(row, meta, locale)}</dd>
                  </div>
                )}
                {showBestArp && (
                  <div>
                    <dt>{t("leaderboard.column.bestArp")}</dt>
                    <dd>{formatNumber(row.stats.bestArp, locale)}</dd>
                  </div>
                )}
                <div>
                  <dt>{t("leaderboard.column.kd")}</dt>
                  <dd>{row.stats.deathless ? formatNumber(row.stats.kills, locale) : formatNumber(row.stats.kd, locale, 2)}</dd>
                </div>
                {meta.primaryMetric !== "killsPerMatch" && (
                  <div>
                    <dt>{rateLabel}</dt>
                    <dd>{formatNumber(row.stats.killsPerMatch, locale, 2)}</dd>
                  </div>
                )}
                <div>
                  <dt>{killsLabel}</dt>
                  <dd>{formatNumber(row.stats.kills, locale)}</dd>
                </div>
                <div>
                  <dt>{t("leaderboard.column.hours")}</dt>
                  <dd>{row.stats.hours == null ? "—" : `${formatNumber(row.stats.hours, locale, 1)}${lang === "ru" ? " ч" : " h"}`}</dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
