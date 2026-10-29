"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { axisLeagueRefreshDelay, cacheAxisLeague, getCachedAxisLeague, getServerAxisLeague, loadClientAxisLeague, subscribeAxisLeague } from "@/lib/client-axis-league";
import AxisPlayerIdentity from "@/components/AxisPlayerIdentity";
import { AXIS_CURRENT_SEASON_START } from "@/lib/axis-seasons";
import AxisMatchHistory from "@/components/AxisMatchHistory";
import AxisLeagueStatistics from "@/components/AxisLeagueStatistics";
import AdminAxisLeague from "@/components/AdminAxisLeague";
import { useI18n } from "@/lib/i18n/context";
import { AXIS_REFRESH_MS, AXIS_SORTS, AXIS_DISCORD_URL, sortAxisPlayers, type AxisPlayer, type AxisSort } from "@/lib/axis-league";

export default function AxisLeaguePage({ initialView = "standings", initialMatch }: { initialMatch?: number; initialView?: "standings" | "history" | "profiles" | "statistics" }) {
  const { t, lang } = useI18n();
  const data = useSyncExternalStore(subscribeAxisLeague, getCachedAxisLeague, getServerAxisLeague);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const handledRetry = useRef(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<AxisSort>("position");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [view, setView] = useState<"standings" | "history" | "profiles" | "statistics">(initialView);
  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const locale = lang === "ru" ? "ru-RU" : "en-US";

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    async function loadAccess() {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error("Session unavailable");
        const body = await response.json();
        if (!controller.signal.aborted) {
          setCanEdit(body.isAdmin === true || body.canEditAxisKda === true);
          setCanSubmit(body.canSubmitAxisScreenshot === true);
        }
      } catch { if (!controller.signal.aborted) { setCanEdit(false); setCanSubmit(false); } }
      finally { running = false; }
    }
    void loadAccess();
    window.addEventListener("focus", loadAccess);
    document.addEventListener("visibilitychange", loadAccess);
    return () => { controller.abort(); window.removeEventListener("focus", loadAccess); document.removeEventListener("visibilitychange", loadAccess); };
  }, [view]);

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(force = false) {
      if (running || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      running = true;
      let delay = AXIS_REFRESH_MS;
      try {
        await loadClientAxisLeague(controller.signal, force);
        if (!controller.signal.aborted) setFailed(false);
        // Reusing a snapshot must not restart its five-minute freshness window.
        delay = axisLeagueRefreshDelay();
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally {
        running = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), delay);
      }
    }
    const onVisible = () => void load();
    // Activity can restart effects on Back while preserving the retry counter.
    const force = retry !== handledRetry.current;
    handledRetry.current = retry;
    void load(force);
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
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
    return <AxisPlayerIdentity player={player} mmr={player.mmr} averageKda={data?.averageKda ?? null} />;
  }

  return (
    <main className="page-frame leaderboard-page axis-page">
      <Link href="/leaderboard" className="back-link">{t("nav.leaderboard")}</Link>
      <header className="axis-hero">
        <h1 className="page-title">{t("axis.title")}</h1>
        <a href={AXIS_DISCORD_URL} target="_blank" rel="noopener noreferrer" className="tactical-button axis-join">{t("axis.join")} <span aria-hidden>↗</span></a>
      </header>
      <div className="axis-season-strip">
        <span className="axis-season-live"><span aria-hidden="true" />{t("axis.season.current")}</span>
        <span>{t("axis.season.since", { date: new Date(data?.currentSeason?.startsAt ?? AXIS_CURRENT_SEASON_START).toLocaleString(locale, { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) })}</span>
        {data && <span className="axis-season-count">{t("axis.results", { n: number(data.players.length) })}<span aria-hidden="true"> · </span>{t("axis.gamesPlayed")}: <strong>{number(data.currentSeason?.games ?? null)}</strong></span>}
      </div>
      <div className="admin-tabs axis-view-switch" role="group" aria-label={t("axis.history.view")}>
        <button type="button" className={view === "standings" ? "is-active" : ""} aria-pressed={view === "standings"} onClick={() => setView("standings")}>{t("axis.standings")}</button>
        <button type="button" className={view === "history" ? "is-active" : ""} aria-pressed={view === "history"} onClick={() => setView("history")}>{t("axis.history.title")}</button>
        <button type="button" className={view === "statistics" ? "is-active" : ""} aria-pressed={view === "statistics"} onClick={() => setView("statistics")}>{lang === "ru" ? "Статистика" : "Statistics"}</button>
        {canEdit && <button type="button" className={view === "profiles" ? "is-active" : ""} aria-pressed={view === "profiles"} onClick={() => setView("profiles")}>{t("axis.profiles.title")}</button>}
      </div>
      <div hidden={view !== "history"}><AxisMatchHistory initialMatch={initialMatch} players={data?.players} averageKda={data?.averageKda ?? null} active={view === "history"} canEditKda={canEdit === true} canSubmitScreenshot={canSubmit} /></div>
      {view === "statistics" && <AxisLeagueStatistics players={data?.players} averageKda={data?.averageKda ?? null} />}
      {view === "profiles" && (canEdit === null ? <p role="status">{t("common.loading")}</p> : canEdit ? <AdminAxisLeague data={data} onChange={cacheAxisLeague} editorOnly /> : <p role="status">{t("axis.profiles.accessDenied")}</p>)}
      {view === "standings" && <>
      <section className="leaderboard-controls axis-controls" aria-label={t("leaderboard.settings")}>
        <label><span>{t("axis.search")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("axis.searchPlaceholder")} /></label>
        <label><span>{t("leaderboard.sort.label")}</span><select value={sort} onChange={(event) => changeSort(event.target.value as AxisSort)}>
          {AXIS_SORTS.map((key) => <option key={key} value={key}>{t("axis.column." + key)}</option>)}
        </select></label>
        <button type="button" className="ghost-button" onClick={() => setDirection(direction === "asc" ? "desc" : "asc")} aria-label={t(direction === "asc" ? "axis.ascending" : "axis.descending")}>
          {t(direction === "asc" ? "axis.ascending" : "axis.descending")} <span aria-hidden>{direction === "asc" ? "↑" : "↓"}</span>
        </button>
      </section>
      {data?.updatedAt != null && <div className="axis-meta"><span>{t("axis.updated", { time: new Date(data.updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}</span></div>}
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
      </>}
    </main>
  );

}
