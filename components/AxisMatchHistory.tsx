"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { axisProfileHref } from "@/lib/axis-league";
import { AXIS_HISTORY_SOURCE_URL, type AxisHistoryResponse, type AxisMatch } from "@/lib/axis-history";

export default function AxisMatchHistory() {
  const { t, lang } = useI18n();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AxisHistoryResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const current = data?.page === page ? data : null;
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const response = await fetch(`/api/axis-league/history?page=${page}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        const body = await response.json() as AxisHistoryResponse;
        if (!response.ok || !body.available || body.page !== page || !Array.isArray(body.matches)) throw new Error("History unavailable");
        if (!controller.signal.aborted) { setData(body); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { running = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 60_000);
    document.addEventListener("visibilitychange", load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [page, retry]);

  function navigate(target: number) { setFailed(false); setPage(target); }
  function teamName(match: AxisMatch, index: number) {
    const name = match.teams[index]?.name;
    return name && !/^Team [A-Z]$/.test(name) ? name : t("axis.history.team", { n: String.fromCharCode(65 + index) });
  }
  function result(match: AxisMatch) {
    if (match.winner === -1) return t("axis.history.cancelled");
    if (match.winner === -2) return t("axis.history.draw");
    if (match.winner == null) return t("axis.history.noResult");
    return t("axis.history.winner", { team: teamName(match, match.winner) });
  }

  return <section className="axis-history" aria-label={t("axis.history.title")}>
    <div className="axis-heading">
      <h2 className="section-heading">{t("axis.history.title")}</h2>
      <a href={AXIS_HISTORY_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="ghost-button">{t("axis.source")} <span aria-hidden>↗</span></a>
    </div>
    <p className="axis-description">{t("axis.history.description")}</p>
    <div className="axis-meta"><span>{t("axis.refreshHint")}</span>{current?.updatedAt != null && <span>{t("axis.updated", { time: new Date(current.updatedAt).toLocaleString(locale) })}</span>}</div>
    {(failed || current?.stale) && <div className="leaderboard-state data-panel" role="status">
      <p>{t(current ? "axis.history.stale" : "axis.history.error")}</p>
      <button type="button" className="ghost-button" onClick={() => setRetry((value) => value + 1)}>{t("admin.retry")}</button>
    </div>}
    {!current && !failed && <p role="status" className="leaderboard-publication">{t("common.loading")}</p>}
    {current && <>
      <nav className="axis-history-pages" aria-label={t("axis.history.pagination")}>
        <button type="button" className="ghost-button" disabled={page === 1} onClick={() => navigate(1)}>{t("axis.history.first")}</button>
        <button type="button" className="ghost-button" disabled={page === 1} onClick={() => navigate(page - 1)}>{t("axis.history.previous")}</button>
        <span role="status">{t("axis.history.page", { page: number(page), pages: number(current.pages), n: number(current.total) })}</span>
        <button type="button" className="ghost-button" disabled={page >= current.pages} onClick={() => navigate(page + 1)}>{t("axis.history.next")}</button>
        <button type="button" className="ghost-button" disabled={page === current.pages} onClick={() => navigate(current.pages)}>{t("axis.history.last")}</button>
      </nav>
      {current.matches.length === 0 ? <p className="axis-empty data-panel">{t("axis.history.empty")}</p> :
        <div className="axis-match-list">{current.matches.map((match, index) => <details className="data-panel axis-match" key={match.number} open={index === 0}>
          <summary>
            <strong>{t("axis.history.match", { n: String(match.number) })}</strong>
            {match.time == null ? <span>{t("axis.history.noTime")}</span> : <time dateTime={new Date(match.time).toISOString()}>{new Date(match.time).toLocaleString(locale)}</time>}
            <span className="axis-match-queue">{match.queue ?? t("axis.history.unknownQueue")}</span>
            <span>{match.maps.length ? match.maps.join(", ") : t("axis.history.noMap")}</span>
            <span className={`axis-match-result${match.winner != null && match.winner >= 0 ? " axis-match-result--winner" : ""}`}>{result(match)}</span>
          </summary>
          {match.teams.length === 0 ? <p className="axis-empty">{t("axis.history.noTeams")}</p> : <div className="axis-match-teams">{match.teams.map((team, teamIndex) => <section key={teamIndex} className={`axis-match-team${match.winner === teamIndex ? " axis-match-team--winner" : ""}`}>
            <div className="axis-match-team-heading"><h3>{teamName(match, teamIndex)}</h3>{match.winner === teamIndex && <span>{t("axis.history.won")}</span>}</div>
            <p className="axis-match-mmr-label">{t("axis.history.mmr")}</p>
            <ul>{team.players.map((player) => <li key={player.id}>
              {player.profile ? <Link href={axisProfileHref(player.profile)} prefetch={false} aria-label={t("axis.openPlayer", { name: player.name })}>{player.name}<span className="axis-profile-mark" aria-hidden>↗</span></Link> : <span>{player.name}</span>}
              <span className="axis-match-stats"><span>{player.mmr == null ? "—" : number(player.mmr)}</span>
                <span className={player.change == null || player.change === 0 ? "" : player.change > 0 ? "axis-match-gain" : "axis-match-loss"} aria-label={t("axis.history.change", { n: player.change == null ? "—" : number(player.change) })}>
                  {player.change == null ? "—" : `${player.change > 0 ? "+" : ""}${number(player.change)}`}
                </span>
              </span>
            </li>)}</ul>
          </section>)}</div>}
        </details>)}</div>}
    </>}
  </section>;
}
