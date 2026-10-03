"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import StatCard from "@/components/StatCard";
import { useI18n } from "@/lib/i18n/context";
import { AXIS_SORTS, AXIS_SOURCE_URL, axisProfileHref, sortAxisPlayers, type AxisLeagueResponse, type AxisPlayer, type AxisSort } from "@/lib/axis-league";

export default function AxisLeaguePage() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<AxisLeagueResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<AxisSort>("position");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const locale = lang === "ru" ? "ru-RU" : "en-US";

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const response = await fetch("/api/axis-league", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        const body = await response.json() as AxisLeagueResponse;
        if (!response.ok || !body.available || !Array.isArray(body.players)) throw new Error("Leaderboard unavailable");
        if (!controller.signal.aborted) { setData(body); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { running = false; }
    }
    void load();
    // Read the local snapshot frequently; the server limits upstream syncs to five minutes.
    const timer = setInterval(() => void load(), 60_000);
    document.addEventListener("visibilitychange", load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [retry]);

  const players = useMemo(() => sortAxisPlayers((data?.players ?? []).filter((player) =>
    player.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), sort, direction), [data, search, sort, direction]);
  const number = (value: number | null, percent = false) => value == null ? "—" :
    value.toLocaleString(locale, percent ? { style: "percent", maximumFractionDigits: 1 } : { maximumFractionDigits: 1 });
  const value = (player: AxisPlayer, key: AxisSort) => key === "position" ? `#${player.position}` : number(player[key], key === "winrate");
  function changeSort(key: AxisSort) {
    setSort(key);
    setDirection(key === sort ? direction === "asc" ? "desc" : "asc" : key === "position" ? "asc" : "desc");
  }

  function playerName(player: AxisPlayer) {
    return player.profile
      ? <Link href={axisProfileHref(player.profile)} prefetch={false} aria-label={t("axis.openPlayer", { name: player.name })}>{player.name}<span className="axis-profile-mark" aria-hidden>↗</span></Link>
      : <span>{player.name}</span>;
  }

  return (
    <main className="page-frame leaderboard-page axis-page">
      <Link href="/leaderboard" className="back-link">{t("nav.leaderboard")}</Link>
      <div className="axis-heading">
        <div><p className="page-kicker">{t("axis.kicker")}</p><h1 className="page-title">{t("axis.title")}</h1></div>
        <a href={AXIS_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="ghost-button">{t("axis.source")} <span aria-hidden>↗</span></a>
      </div>
      <p className="axis-description">{t("axis.description")}</p>
      {data && <div className="axis-summary">
        <StatCard label={t("axis.players")} value={number(data.players.length)} />
        <StatCard label={t("axis.linked")} value={number(data.players.filter((player) => player.profile).length)} />
        <StatCard label={t("axis.topMmr")} value={number(data.players.length ? Math.max(...data.players.map((player) => player.mmr)) : null)} />
      </div>}
      <section className="leaderboard-controls data-panel axis-controls" aria-label={t("leaderboard.settings")}>
        <label><span>{t("axis.search")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("axis.searchPlaceholder")} /></label>
        <label><span>{t("leaderboard.sort.label")}</span><select value={sort} onChange={(event) => changeSort(event.target.value as AxisSort)}>
          {AXIS_SORTS.map((key) => <option key={key} value={key}>{t("axis.column." + key)}</option>)}
        </select></label>
        <button type="button" className="ghost-button" onClick={() => setDirection(direction === "asc" ? "desc" : "asc")} aria-label={t(direction === "asc" ? "axis.ascending" : "axis.descending")}>
          {t(direction === "asc" ? "axis.ascending" : "axis.descending")} <span aria-hidden>{direction === "asc" ? "↑" : "↓"}</span>
        </button>
      </section>
      <div className="axis-meta"><span>{t("axis.refreshHint")}</span>{data?.updatedAt != null && <span>{t("axis.updated", { time: new Date(data.updatedAt).toLocaleString(locale) })}</span>}</div>
      {(failed || data?.stale) && <div className="leaderboard-state data-panel" role="status">
        <p>{t(data ? "axis.stale" : "axis.error")}</p><button className="ghost-button" type="button" onClick={() => setRetry((value) => value + 1)}>{t("admin.retry")}</button>
      </div>}
      {!data && !failed && <p className="leaderboard-publication" role="status">{t("common.loading")}</p>}
      {data && <section className="leaderboard-list data-panel axis-list" aria-label={t("axis.title")}>
        <div className="leaderboard-list__heading"><h2 className="section-heading">{t("axis.standings")}</h2><span>{t("axis.results", { n: number(players.length) })}</span></div>
        {players.length === 0 ? <p className="axis-empty">{t(data.players.length === 0 ? "axis.empty" : "axis.noResults")}</p> : <>
          <div className="leaderboard-table-wrap axis-table-wrap">
            <table className="leaderboard-table axis-table">
              <caption className="sr-only">{t("axis.standings")}</caption>
              <thead><tr>
                {AXIS_SORTS.map((column, index) => <Fragment key={column}>
                  <th scope="col" aria-sort={sort === column ? direction === "asc" ? "ascending" : "descending" : "none"}>
                    <button type="button" className="axis-column-sort" onClick={() => changeSort(column)} aria-label={t("axis.sortBy", { metric: t("axis.column." + column) })}>
                      {t("axis.column." + column)}{sort === column && <span aria-hidden>{direction === "asc" ? " ↑" : " ↓"}</span>}
                    </button>
                  </th>
                  {index === 0 && <th scope="col" className="leaderboard-table__player">{t("leaderboard.column.player")}</th>}
                </Fragment>)}
              </tr></thead>
              <tbody>{players.map((player) => <tr key={player.id}>
                <td className={`axis-position${player.position <= 3 ? " axis-position--top" : ""}`}>{value(player, "position")}</td>
                <th scope="row" className="leaderboard-table__player">{playerName(player)}</th>
                {AXIS_SORTS.slice(1).map((key) => <td key={key} className={key === "mmr" ? "axis-mmr" : undefined}>{value(player, key)}</td>)}
              </tr>)}</tbody>
            </table>
          </div>
          <ol className="axis-cards" aria-label={t("axis.standings")}>{players.map((player) => <li key={player.id} className="leaderboard-card">
            <div className="leaderboard-card__top"><strong className="leaderboard-card__name">{playerName(player)}</strong><span className="leaderboard-card__rank">{value(player, "position")}</span></div>
            <dl className="leaderboard-card__grid">{AXIS_SORTS.slice(1).map((key) => <div key={key}><dt>{t("axis.column." + key)}</dt><dd className={key === "mmr" ? "axis-mmr" : undefined}>{value(player, key)}</dd></div>)}</dl>
          </li>)}</ol>
        </>}
      </section>}
    </main>
  );

}
