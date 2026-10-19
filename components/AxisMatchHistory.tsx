"use client";

import type { AxisPlayer } from "@/lib/axis-league";
import AxisPlayerIdentity from "@/components/AxisPlayerIdentity";
import AxisMatchAttribution from "@/components/AxisMatchAttribution";
import AxisMatchStatsEditor from "@/components/AxisMatchStatsEditor";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { type AxisHistoryResponse, type AxisMatch } from "@/lib/axis-history";

export default function AxisMatchHistory({ active = true, canEditKda = false, initialMatch, players, averageKda }: { active?: boolean; canEditKda?: boolean; initialMatch?: number; players?: AxisPlayer[]; averageKda?: number | null }) {
  const { t, lang } = useI18n();
  const [page, setPage] = useState(1);
  const pendingScroll = useRef(false);
  const scrolledMatch = useRef<number | undefined>(undefined);
  const [season, setSeason] = useState(initialMatch ? "all" : "current");
  const [focusedMatch, setFocusedMatch] = useState(initialMatch);
  const [data, setData] = useState<AxisHistoryResponse | null>(null);
  const [cachedPages, setCachedPages] = useState<AxisHistoryResponse[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const current = data?.page === page && data?.season === season && data?.matchNumber === focusedMatch ? data : cachedPages.find((entry) => entry.page === page && entry.season === season && entry.matchNumber === focusedMatch) ?? null;
  const leaguePlayers = new Map(players?.map((player) => [player.id, player]));
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const response = await fetch(focusedMatch ? `/api/axis-league/history?match=${focusedMatch}&season=all` : `/api/axis-league/history?page=${page}&season=${season}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        const body = await response.json() as AxisHistoryResponse;
        if (!response.ok || !body.available || body.page !== page || body.season !== season || body.matchNumber !== focusedMatch || !Array.isArray(body.matches)) throw new Error("History unavailable");
        if (!controller.signal.aborted) {
          setData(body); setFailed(false);
          setCachedPages((previous) => [body, ...previous.filter((entry) => entry.page !== page || entry.season !== season || entry.matchNumber !== focusedMatch)].slice(0, 8));
        }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { running = false; }
    }
    void load();
    // Current results follow the five-minute import; historical pages only check for manual edits.
    const timer = setInterval(() => void load(), season === "current" || season === "all" ? 5 * 60_000 : 10 * 60_000);
    document.addEventListener("visibilitychange", load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [active, page, season, retry, focusedMatch]);

  useEffect(() => {
    if (!active || !current) return;
    const matchNumber = focusedMatch ?? (pendingScroll.current ? current.matches[0]?.number : undefined);
    if (matchNumber == null || focusedMatch != null && scrolledMatch.current === focusedMatch) return;
    const match = document.getElementById(`axis-match-${matchNumber}`);
    if (!match) return;
    match.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    pendingScroll.current = false;
    scrolledMatch.current = focusedMatch;
  }, [active, focusedMatch, current]);

  function clearMatch() {
    setFocusedMatch(undefined); setPage(1); setSeason("current"); setFailed(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("match"); url.hash = "";
    window.history.replaceState(null, "", url);
  }

  function navigate(target: number) { pendingScroll.current = true; setFailed(false); setPage(target); }
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
    {focusedMatch && <button type="button" className="back-link" onClick={clearMatch}>← {t("axis.history.title")}</button>}
    <div className="axis-history-toolbar" hidden={focusedMatch != null}>
      <label><span>{t("axis.season.label")}</span><select value={season} onChange={(event) => { setPage(1); setFailed(false); setSeason(event.target.value); }}>
        <option value="current">{t("axis.season.current")}</option>
        {(data?.seasons ?? []).filter((entry) => !entry.current).map((entry) => <option key={entry.id} value={entry.id}>{t("axis.season.from", { date: new Date(entry.startsAt).toLocaleDateString(locale, { timeZone: "Europe/Moscow", day: "numeric", month: "short", year: "numeric" }) })}</option>)}
        <option value="all">{t("axis.season.all")}</option>
      </select></label>
      <p>{season === "current" ? t("axis.season.currentHint") : t("axis.season.inferredHint")}</p>
    </div>
    {current && !current.archiveComplete && <p className="axis-meta" role="status">{t("axis.season.importing")}</p>}
    {(failed || current?.stale) && <div className="leaderboard-state data-panel" role="status">
      <p>{t(current ? "axis.history.stale" : "axis.history.error")}</p>
      <button type="button" className="ghost-button" onClick={() => setRetry((value) => value + 1)}>{t("admin.retry")}</button>
    </div>}
    {!current && !failed && <p role="status" className="leaderboard-publication">{t("common.loading")}</p>}
    {current && <>
      {focusedMatch == null && current.summary && <section className="axis-history-summary data-panel" aria-label={t("axis.history.summary")}>
        <h2 className="section-heading">{t("axis.history.summary")}</h2>
        <p className="axis-history-summary__hint">{t(season === "all" ? "axis.history.archiveSummaryHint" : "axis.history.summaryHint")}</p>
        <dl className="axis-history-summary__metrics">
          <div><dt>{t("axis.gamesPlayed")}</dt><dd>{number(current.summary.played)}</dd></div>
          <div><dt>{t("axis.history.wins", { team: "A" })}</dt><dd>{number(current.summary.winsA)}</dd></div>
          <div><dt>{t("axis.history.wins", { team: "B" })}</dt><dd>{number(current.summary.winsB)}</dd></div>
        </dl>
        <p className="axis-history-summary__leader">{current.summary.winsA === current.summary.winsB
          ? t(current.summary.played === 0 ? "axis.history.noPlayed" : "axis.history.equalWins")
          : t("axis.history.leading", { team: t("axis.history.team", { n: current.summary.winsA > current.summary.winsB ? "A" : "B" }) })}</p>
        <h3>{t("axis.history.maps")}</h3>
        {current.summary.maps.length === 0 ? <p className="axis-meta">{t("axis.history.noMap")}</p> : <ol className="axis-history-summary__maps">{current.summary.maps.map((map) => <li key={map.name}>
          <span>{map.name}</span><strong>{number(map.matches)}</strong>
          <span className="axis-history-summary__bar" aria-hidden="true" style={{ width: `${map.matches / current.summary!.maps[0].matches * 100}%` }} />
        </li>)}</ol>}
      </section>}
      <nav hidden={focusedMatch != null} className="axis-history-pages" aria-label={t("axis.history.pagination")}>
        <button type="button" className="ghost-button" disabled={page === 1} onClick={() => navigate(1)}>{t("axis.history.first")}</button>
        <button type="button" className="ghost-button" disabled={page === 1} onClick={() => navigate(page - 1)}>{t("axis.history.previous")}</button>
        <span role="status">{t("axis.history.page", { page: number(page), pages: number(current.pages), n: number(current.total) })}</span>
        <button type="button" className="ghost-button" disabled={page >= current.pages} onClick={() => navigate(page + 1)}>{t("axis.history.next")}</button>
        <button type="button" className="ghost-button" disabled={page === current.pages} onClick={() => navigate(current.pages)}>{t("axis.history.last")}</button>
      </nav>
      {current.matches.length === 0 ? <p className="axis-empty data-panel">{t("axis.history.empty")}</p> :
        <div className="axis-match-list" key={`${season}:${page}:${focusedMatch ?? "all"}`}>{current.matches.map((match, index) => <details id={`axis-match-${match.number}`} className="data-panel axis-match" key={match.number} open={index === 0}>
          <summary onClick={(event) => {
            const match = event.currentTarget.parentElement as HTMLDetailsElement;
            if (!match.open) requestAnimationFrame(() => match.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }));
          }}>
            <strong>{t("axis.history.match", { n: String(match.number) })}</strong>
            {match.time == null ? <span>{t("axis.history.noTime")}</span> : <time dateTime={new Date(match.time).toISOString()}>{new Date(match.time).toLocaleString(locale)}</time>}
            <span className="axis-match-queue">{match.queue ?? t("axis.history.unknownQueue")}</span>
            <span>{match.maps.length ? match.maps.join(", ") : t("axis.history.noMap")}</span>
            <span className={`axis-match-result${match.winner != null && match.winner >= 0 ? " axis-match-result--winner" : ""}`}>{result(match)}</span>
          </summary>
          <AxisMatchAttribution edited={match.edited} />
          <AxisMatchStatsEditor match={match} canEdit={canEditKda} onConflict={() => { setCachedPages([]); setRetry((value) => value + 1); }} onSaved={(players, rounds, edited) => {
            setCachedPages([]);
            const saved = new Map(players.map((entry) => [entry.discordId, entry.kda]));
            setData((previous) => previous ? { ...previous, matches: previous.matches.map((entry) => entry.number !== match.number ? entry : { ...entry,
              rounds: rounds === undefined ? entry.rounds : rounds,
              edited: edited ?? entry.edited,
              teams: entry.teams.map((team) => ({ ...team, players: team.players.map((player) => saved.has(player.id) ? { ...player, kda: saved.get(player.id)! } : player) })) }) } : previous);
            setRetry((value) => value + 1);
          }}>{({ teams, renderInputs, rounds, editing }) => <>
            {rounds}
          {teams.length === 0 ? <p className="axis-empty">{t("axis.history.noTeams")}</p> : <div className="axis-match-teams">{teams.map((team, teamIndex) => <section key={teamIndex} className={`axis-match-team${match.winner === teamIndex ? " axis-match-team--winner" : ""}`}>
            <div className="axis-match-team-heading"><h3>{teamName(match, teamIndex)}</h3>{match.winner === teamIndex && <span>{t("axis.history.won")}</span>}</div>
            <p className="axis-match-mmr-label">{t("axis.kda.short")} · {t("axis.history.mmr")}</p>
            <ul>{team.players.map((player) => <li key={player.id}>
              <AxisPlayerIdentity player={leaguePlayers.get(player.id) ?? player} mmr={leaguePlayers.get(player.id)?.mmr ?? null} averageKda={averageKda} showArenaNickname={editing} />
              <div className="axis-match-values">
              {renderInputs(player.id) ?? <span className="axis-match-kda" aria-label={t("axis.kda.value", { kills: player.kda?.kills ?? "—", deaths: player.kda?.deaths ?? "—", assists: player.kda?.assists ?? "—" })}>
                <small>{t("axis.kda.short")}</small><strong>{player.kda ? `${player.kda.kills} / ${player.kda.deaths} / ${player.kda.assists}` : "— / — / —"}</strong>
              </span>}
              <span className="axis-match-stats"><span>{player.mmr == null ? "—" : number(player.mmr)}</span>
                <span className={player.change == null || player.change === 0 ? "" : player.change > 0 ? "axis-match-gain" : "axis-match-loss"} aria-label={t("axis.history.change", { n: player.change == null ? "—" : number(player.change) })}>
                  {player.change == null ? "—" : `${player.change > 0 ? "+" : ""}${number(player.change)}`}
                </span>
              </span>
              </div>
            </li>)}</ul>
          </section>)}</div>}
          </>}</AxisMatchStatsEditor>
        </details>)}</div>}
    </>}
  </section>;
}
