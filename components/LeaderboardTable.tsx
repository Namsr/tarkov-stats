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

function displayRank(row: LeaderboardRow, sort: LeaderboardSort, direction: "desc" | "asc", rankedCount: number): string {
  if (row.status === "insufficient_sample" && row.groupStart != null) return `#${row.groupStart}+`;
  // Rank follows the active sort: primary rank for the primary sort, sort position otherwise.
  // Ascending display mirrors the server window, so ranked rows show the mirrored
  // global rank instead of the descending server rank.
  const rank = sort === "primary" ? row.primaryRank : row.position;
  if (row.status === "ranked" && rank != null) {
    if (direction === "asc" && rankedCount > 0 && rank >= 1 && rank <= rankedCount) {
      return `#${rankedCount - rank + 1}`;
    }
    return `#${rank}`;
  }
  return "—";
}

function RankCell({ row, sort, direction, rankedCount, href }: { row: LeaderboardRow; sort: LeaderboardSort; direction: "desc" | "asc"; rankedCount: number; href: string }) {
  const rank = displayRank(row, sort, direction, rankedCount);
  return rank === "—" ? rank : <Link href={href} prefetch={false}>{rank}</Link>;
}

// FLIP: rows glide to their new positions on resort instead of swapping instantly.
// Positions come from getBoundingClientRect, which stays reliable for table rows
// under table-layout:fixed with a sticky thead (unlike offsetTop). Runs only when
// the row order changes; unchanged rows are no-ops. The previous FLIP animation
// on an element is cancelled before a new one starts so rapid resorts never stack.
// Skipped entirely under prefers-reduced-motion.
const flipActive = new WeakMap<Element, Animation>();
function flipRows(container: HTMLElement | null, prev: Map<number, number>): Map<number, number> {
  const current = new Map<number, number>();
  if (!container) return current;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  container.querySelectorAll("[data-aid]").forEach((node) => {
    const el = node as HTMLElement;
    const top = el.getBoundingClientRect().top;
    const aid = Number(el.dataset.aid);
    current.set(aid, top);
    if (reduceMotion) return;
    const from = prev.get(aid);
    if (from == null || from === top) return;
    flipActive.get(el)?.cancel();
    const anim = el.animate(
      [{ transform: `translateY(${from - top}px)` }, { transform: "translateY(0)" }],
      { duration: 340, easing: "cubic-bezier(.22,1,.36,1)" },
    );
    flipActive.set(el, anim);
    anim.onfinish = () => {
      if (flipActive.get(el) === anim) flipActive.delete(el);
    };
  });
  return current;
}

export default function LeaderboardTable({
  id,
  title,
  rows,
  meta,
  direction = "desc",
}: {
  id: string;
  title: string;
  rows: LeaderboardRow[];
  meta: LeaderboardMeta;
  direction?: "desc" | "asc";
}) {
  const { lang, t } = useI18n();
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const cardsRef = useRef<HTMLOListElement>(null);
  const flipPrev = useRef({ tbody: new Map<number, number>(), cards: new Map<number, number>() });
  useLayoutEffect(() => {
    flipPrev.current.tbody = flipRows(tbodyRef.current, flipPrev.current.tbody);
    flipPrev.current.cards = flipRows(cardsRef.current, flipPrev.current.cards);
  }, [rows]);
  // Upstream exposes only best ARP — there is no current ARP data.
  // Hide the primary ARP column for BlastGang and keep best ARP as the rating.
  // Best ARP is shown only for BlastGang; other Arena modes keep arena numbers.
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
                    <RankCell row={row} sort={meta.sort} direction={direction} rankedCount={meta.rankedCount} href={`/leaderboard?${focusParams}`} />
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
          const rank = displayRank(row, meta.sort, direction, meta.rankedCount);
          return (
            <li
              key={row.aid}
              data-aid={row.aid}
              style={{ "--lb-i": index } as CSSProperties}
              className="leaderboard-card"
              data-leaderboard-selected={row.selected ? "true" : undefined}
              aria-current={row.selected ? "true" : undefined}
              tabIndex={row.selected ? -1 : undefined}
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
                  <dd>{row.stats.hours == null ? "—" : t("leaderboard.hoursValue", { v: formatNumber(row.stats.hours, locale, 1) })}</dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
