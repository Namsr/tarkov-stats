"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { AxisAvatar } from "@/components/AxisPlayerIdentity";
import AxisIcon from "@/components/AxisIcon";
import { arenaBarPositionFromRatio } from "@/components/arena-ui";
import { axisKdaRatio, axisMatchHref, type AxisProfile } from "@/lib/axis-league";
import { axisPlayerHref, axisPlayerResult, AXIS_PEER_MIN_MATCHES, AXIS_STORY_MAP_MIN_MATCHES, type AxisPeer } from "@/lib/axis-player-profile";
import { axisPlayerRequest, cachedAxisPlayer, loadAxisPlayer } from "@/lib/client-axis-player";
import { sortAxisMatchPlayers, type AxisMatch } from "@/lib/axis-history";
import "./axis-profile.css";

type NamedPlayer = { name: string; avatarUrl?: string | null; profile: AxisProfile | null };
function PlayerName({ player, link = true }: { player: NamedPlayer; link?: boolean }) {
  const content = <><AxisAvatar name={player.name} url={player.avatarUrl} /><span>{player.name}</span></>;
  return link && player.profile ? <Link className="axis-personal-name" href={axisPlayerHref(player.profile)} prefetch={false}>{content}</Link>
    : <span className="axis-personal-name">{content}</span>;
}

export default function AxisPlayerPanel({ aid }: { aid: number }) {
  const { t, lang } = useI18n();
  const [season, setSeason] = useState("current"), [page, setPage] = useState(1), [filter, setFilter] = useState("all");
  const [peerView, setPeerView] = useState<"teammates" | "opponents">("teammates");
  const [recent, setRecent] = useState(false), [retry, setRetry] = useState(0), [failed, setFailed] = useState(false);
  const request = axisPlayerRequest(aid, season, page, filter);
  const [saved, setSaved] = useState(() => ({ request, data: cachedAxisPlayer(request) }));
  const handledRetry = useRef(0);
  const historyPreload = useRef<AbortController | null>(null);
  // Keep this player and season mounted while only the history query changes.
  const cached = cachedAxisPlayer(request);
  const data = cached ?? (saved.data?.aid === aid && saved.data.season === season ? saved.data : null);
  const historyPending = !cached && saved.request !== request;
  useEffect(() => {
    const controller = new AbortController();
    historyPreload.current = controller;
    return () => { controller.abort(); historyPreload.current = null; };
  }, [aid, season]);
  function preloadHistory(result: string) {
    const signal = historyPreload.current?.signal;
    if (signal && result !== filter && document.visibilityState !== "hidden") {
      void loadAxisPlayer(axisPlayerRequest(aid, season, 1, result), signal).catch(() => {});
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    async function load(force = false) {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const body = await loadAxisPlayer(request, controller.signal, force);
        if (!controller.signal.aborted) { setSaved({ request, data: body }); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { running = false; }
    }
    const force = handledRetry.current !== retry; handledRetry.current = retry;
    void load(force);
    const visible = () => void load();
    const timer = setInterval(visible, 5 * 60_000);
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [request, retry]);
  const number = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(lang, { maximumFractionDigits: digits });
  const percent = (value: number | null) => value == null ? "—" : `${number(value * 100, 1)}%`;

  if (!data) return <div className="axis-personal-state" role="status">
    <p>{t(failed ? "axis.profile.error" : "common.loading")}</p>
    {failed && <button className="ghost-button" type="button" onClick={() => setRetry(value => value + 1)}>{t("admin.retry")}</button>}
  </div>;

  function delta(key: "winrate" | "wins" | "losses") {
    const value = data!.stats[key], average = data!.averages[key];
    if (value == null || average == null || average <= 0) return null;
    const difference = key === "winrate" ? (value - average) * 100 : (value / average - 1) * 100;
    const label = `${difference > 0 ? "+" : ""}${number(difference, 1)}${key === "winrate" ? ` ${t("arena.combat.pp")}` : "%"}`;
    const description = t("axis.profile.comparison", { value: key === "winrate" ? percent(average) : number(average, 1) });
    return <span className="axis-personal-delta" data-positive={key === "winrate" && difference >= 0 || undefined} title={description}>{label}<span className="sr-only"> {description}</span></span>;
  }
  function record(peer: AxisPeer) {
    return [outcomeCount("wins", peer.wins), outcomeCount("losses", peer.losses),
      ...(peer.draws ? [t("axis.profile.drawCount", { n: number(peer.draws) })] : [])].join(" · ");
  }
  function card(title: string, peer: AxisPeer | null, kind: "with" | "against") {
    const content = <>
      <span className="axis-personal-card-label"><AxisIcon name={kind === "with" ? "handshake" : "swords"} />{title}</span>
      {peer ? <><PlayerName player={peer} link={false} /><strong className="axis-personal-card-value">{t(kind === "with" ? "axis.profile.withWinrate" : "axis.profile.againstWinrate", { n: percent(peer.winrate) })}</strong><small>{record(peer)}</small></>
        : <p className="axis-personal-empty">{kind === "against" ? t("axis.profile.noNemesis") : t("axis.profile.insufficient", { n: AXIS_PEER_MIN_MATCHES })}</p>}
    </>;
    return peer?.profile ? <Link className="axis-personal-card" data-kind={kind} href={axisPlayerHref(peer.profile)} prefetch={false}>{content}</Link>
      : <article className="axis-personal-card" data-kind={kind}>{content}</article>;
  }
  const personalRecent = data.recent;
  const recentWins = personalRecent.filter(match => match.won === true).length;
  const recentLosses = personalRecent.filter(match => match.won === false).length;
  const recentDraws = personalRecent.length - recentWins - recentLosses;
  const plural = new Intl.PluralRules(lang);
  function outcomeCount(kind: "wins" | "losses", count: number) {
    const rule = plural.select(count);
    return t("axis.profile." + kind + "." + (rule === "one" || rule === "few" || rule === "many" ? rule : "other"), { n: number(count) });
  }
  const recordedRecent = personalRecent.filter(match => match.kda != null);
  const combat = recent ? recordedRecent.length ? recordedRecent.reduce((sum, match) => ({ kills: sum.kills + match.kda!.kills, deaths: sum.deaths + match.kda!.deaths, assists: sum.assists + match.kda!.assists, matches: sum.matches + 1 }), { kills: 0, deaths: 0, assists: 0, matches: 0 }) : null : data.combat;
  const kda = combat ? axisKdaRatio(combat) : null;
  const averageKda = recent ? data.averageRecentKda : data.averageKda;
  const ratio = kda != null && averageKda != null && averageKda > 0 ? kda / averageKda : null;
  const width = arenaBarPositionFromRatio(ratio);
  const peers = data[peerView];
  const ally = data.highlights.ally;
  const stats = data.stats;
  const score = (match: AxisMatch) => {
    if (!match.rounds) return "—";
    const own = match.teams.findIndex(team => team.players.some(player => player.id === data.identity.id));
    return own === 1 ? `${match.rounds.b} : ${match.rounds.a}` : `${match.rounds.a} : ${match.rounds.b}`;
  };
  function resultLabel(match: AxisMatch) {
    const result = axisPlayerResult(match, data!.identity.id);
    return t(result === "win" ? "axis.preview.win" : result === "loss" ? "axis.preview.loss" : result === "draw" ? "axis.history.draw" : result === "cancelled" ? "axis.history.cancelled" : "axis.history.noResult");
  }

  return <div className="axis-personal">
    <section id="axis-player-overview" className="profile-anchor-section">
      <div className="axis-personal-heading"><div><p className="section-kicker">{t("axis.kicker")}</p><h2 className="section-heading">{t("axis.title")}</h2></div>
        <label className="profile-select"><span>{t("axis.season.label")}</span><select value={season} onChange={event => { setSeason(event.target.value); setPage(1); setFailed(false); }}>
          {(data.history.seasons ?? []).map(entry => <option value={entry.id} key={entry.id}>{entry.current ? t("axis.season.current") : t("axis.season.from", { date: new Date(entry.startsAt).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Moscow" }) })}</option>)}
          <option value="all">{t("axis.profile.allSeasons")}</option>
        </select></label>
      </div>
      {(failed || data.stale) && <p className="profile-chart-notice" role="status">{t("axis.history.stale")} <button type="button" className="ghost-button" onClick={() => setRetry(value => value + 1)}>{t("admin.retry")}</button></p>}
      {!data.history.archiveComplete && <p className="axis-personal-note" role="status">{t("axis.season.importing")}</p>}
      <div className="axis-personal-summary">
        <p className="axis-personal-average-label">{t("axis.profile.compared")}</p>
        <dl className="axis-personal-primary">
          <div><dt>{t("axis.column.position")}</dt><dd>{stats.position == null ? "—" : `#${number(stats.position)}`}</dd></div>
          <div><dt>{t("axis.column.mmr")}</dt><dd>{number(stats.mmr)}</dd></div>
          <div><dt>{t("axis.column.winrate")}</dt><dd>{percent(stats.winrate)}</dd>{delta("winrate")}</div>
          <div><dt>{t("axis.column.games")}</dt><dd>{number(stats.games)}</dd></div>
        </dl>
        <dl className="axis-personal-secondary">
          <div><dt>{t("axis.column.peakMmr")}</dt><dd>{number(stats.peakMmr)}</dd></div>
          <div><dt>{t("axis.column.wins")}</dt><dd>{number(stats.wins)}</dd>{delta("wins")}</div>
          <div><dt>{t("axis.column.losses")}</dt><dd>{number(stats.losses)}</dd>{delta("losses")}</div>
          <div><dt>{t("axis.column.streak")}</dt><dd>{stats.streak > 0 ? "+" : ""}{number(stats.streak)}</dd></div>
          <div><dt>{t("axis.column.peakStreak")}</dt><dd>{number(stats.peakStreak)}</dd></div>
        </dl>
      </div>
    </section>
    <section className="axis-personal-section">
      <div className="axis-personal-heading"><div><h2 className="section-heading">{t("axis.profile.combat")}</h2><p className="axis-personal-note">{t("axis.profile.averageKda")} <strong>{combat ? [combat.kills, combat.deaths, combat.assists].map(n => number(n / combat.matches, 1)).join(" / ") : "— / — / —"}</strong></p></div>
        <div className="profile-segments" role="group" aria-label={t("axis.profile.combatRange")}><button type="button" aria-pressed={!recent} onClick={() => setRecent(false)}>{t("axis.profile.period")}</button><button type="button" aria-pressed={recent} onClick={() => setRecent(true)}>{t("axis.profile.lastTen")}</button></div>
      </div>
      <div className="axis-personal-recent"><span>{t("axis.profile.lastTen")}</span><div>{[...personalRecent].reverse().map(match => <Link key={match.number} href={axisMatchHref(match.number)} prefetch={false} data-result={match.won == null ? "draw" : match.won ? "win" : "loss"} aria-label={t("axis.history.match", { n: match.number })}>{t(match.won == null ? "axis.preview.drawMark" : match.won ? "axis.preview.winMark" : "axis.preview.lossMark")}</Link>)}</div><span className="axis-personal-recent-summary">{[outcomeCount("wins", recentWins), outcomeCount("losses", recentLosses), recentDraws ? t("axis.profile.drawCount", { n: number(recentDraws) }) : null].filter(Boolean).join(" · ")}</span></div>
      <div className="arena-comparison-row"><div className="arena-comparison-row__heading"><div><h3>{t("axis.preview.kda")}</h3><p>{t("axis.preview.average")}: {number(averageKda, 2)}</p></div><div className="arena-comparison-row__value"><strong>{number(kda, 2)}</strong>{ratio != null && <p>{ratio >= 1 ? "+" : ""}{number((ratio - 1) * 100, 1)}% {t("arena.combat.vsAverage")}</p>}</div></div>
        <div className="arena-comparison-track" role="img" aria-label={t("axis.profile.kdaComparison", { value: number(kda, 2), average: number(averageKda, 2) })}>
          {width != null && <span className="arena-comparison-fill" style={{ width: `${width}%` }} />}{averageKda != null && averageKda > 0 && <span className="arena-comparison-average" aria-hidden="true" />}
        </div>
      </div>
      <p className="axis-personal-note">{t("axis.profile.coverage", { n: combat?.matches ?? 0, total: recent ? personalRecent.length : data.archivedGames })}</p>
    </section>
    <section id="axis-player-peers" className="axis-personal-section profile-anchor-section">
      <div className="axis-personal-heading"><h2 className="section-heading">{t("axis.profile.connections")}</h2><span className="axis-personal-note">{t("axis.profile.minimum", { n: AXIS_PEER_MIN_MATCHES })}</span></div>
      <p className="axis-personal-note">{t("axis.profile.perspective", { name: data.identity.name })}</p>
      <div className="axis-personal-cards">{card(t("axis.profile.bestTeammate"), data.highlights.teammate, "with")}{card(t("axis.profile.nemesis"), data.highlights.opponent, "against")}
        {(() => { const content = <><span className="axis-personal-card-label"><AxisIcon name="split" />{t("axis.profile.betterWith")}</span>{ally ? <><PlayerName player={ally.with} link={false} /><div className="axis-personal-split"><span><small>{t("axis.profile.with")}</small><strong>{percent(ally.with.winrate)}</strong></span><span><small>{t("axis.profile.against")}</small><strong>{percent(ally.against.winrate)}</strong></span></div><small>{t("axis.profile.dualCount", { with: ally.with.wins + ally.with.losses, against: ally.against.wins + ally.against.losses })}</small></> : <p className="axis-personal-empty">{t("axis.profile.insufficient", { n: AXIS_PEER_MIN_MATCHES })}</p>}</>;
          return ally?.with.profile ? <Link className="axis-personal-card" href={axisPlayerHref(ally.with.profile)} prefetch={false}>{content}</Link> : <article className="axis-personal-card">{content}</article>; })()}
      </div>
      <p className="axis-personal-note">{t("axis.profile.highlightRule")}</p>
      <div className="profile-segments axis-personal-peer-tabs" role="group" aria-label={t("axis.profile.connections")}>
        {(["teammates", "opponents"] as const).map(view => <button key={view} type="button" aria-pressed={peerView === view} onClick={() => setPeerView(view)}>{t("axis.profile." + view)}</button>)}
      </div>
      <div className="axis-personal-peer-table"><div className="axis-personal-peer-row axis-personal-peer-head"><span>{t("axis.profile.player")}</span><span>{t("axis.column.games")}</span><span>{t("axis.column.wins")}</span><span>{t("axis.column.losses")}</span><span>{t(peerView === "teammates" ? "axis.profile.withWinrateLabel" : "axis.profile.againstWinrateLabel")}</span></div>
        {peers.length ? peers.map(peer => <div className="axis-personal-peer-row" key={peer.id}><PlayerName player={peer} /><span>{number(peer.games)}</span><span>{number(peer.wins)}</span><span>{number(peer.losses)}</span><span className="axis-personal-peer-winrate"><span>{percent(peer.winrate)}</span>{peer.winrate != null && <span className="axis-personal-peer-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(1, peer.winrate)) * 100}%` }} /></span>}</span></div>) : <p className="axis-personal-note">{t("axis.profile.noPeers")}</p>}
      </div>
    </section>
    <section id="axis-player-history" className="axis-personal-section profile-anchor-section" aria-busy={historyPending && !failed}>
      <div className="axis-personal-heading"><h2 className="section-heading">{t("axis.history.title")}</h2><div className="profile-segments" role="group" aria-label={t("axis.profile.result")}>
        {(["all", "win", "loss"] as const).map(result => <button key={result} type="button" aria-pressed={filter === result} onPointerEnter={() => preloadHistory(result)} onFocus={() => preloadHistory(result)} onClick={() => { setPage(1); setFilter(result); setFailed(false); }}>{t(result === "all" ? "axis.profile.all" : result === "win" ? "axis.column.wins" : "axis.column.losses")}</button>)}
      </div></div>
      {historyPending && <p className={failed ? "profile-chart-notice" : "sr-only"} role="status">{t(failed ? "axis.profile.error" : "common.loading")}{failed && <> <button type="button" className="ghost-button" onClick={() => { setFailed(false); setRetry(value => value + 1); }}>{t("admin.retry")}</button></>}</p>}
      <div className="axis-personal-history-head"><span>{t("axis.profile.result")}</span><span>{t("axis.profile.mapMatch")}</span><span>{t("axis.rounds.label")}</span><span className="axis-personal-history-kda">{t("axis.kda.short")}</span><span>{t("axis.column.mmr")}</span></div>
      {data.history.matches.length ? data.history.matches.map(match => {
        const own = match.teams.flatMap(team => team.players).find(player => player.id === data.identity.id);
        const result = axisPlayerResult(match, data.identity.id);
        return <details className="axis-personal-match" key={match.number} id={`axis-personal-match-${match.number}`}><summary>
          <span className="axis-personal-result" data-result={result}>{resultLabel(match)}</span>
          <span><strong>{match.maps.join(", ") || t("axis.history.noMap")}</strong><small>#{match.number}{match.time != null && <> · <time dateTime={new Date(match.time).toISOString()}>{new Date(match.time).toLocaleString(lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></>}</small></span>
          <span>{score(match)}</span><span className="axis-personal-history-kda">{own?.kda ? `${own.kda.kills} / ${own.kda.deaths} / ${own.kda.assists}` : "— / — / —"}</span>
          <span className="axis-personal-result" data-result={own?.change != null && own.change > 0 ? "win" : own?.change != null && own.change < 0 ? "loss" : "draw"}>{own?.change != null && own.change > 0 ? "+" : ""}{number(own?.change)}</span>
        </summary><div className="axis-personal-rosters">{match.teams.map((team, index) => <section key={index}><h3>{t("axis.history.team", { n: String.fromCharCode(65 + index) })}</h3>{sortAxisMatchPlayers(team.players, lang).map(player => <div className="axis-personal-roster-row" data-self={player.id === data.identity.id || undefined} key={player.id}><PlayerName player={player} /><span>{player.kda ? `${player.kda.kills} / ${player.kda.deaths} / ${player.kda.assists}` : "— / — / —"}</span></div>)}</section>)}</div></details>;
      }) : <p className="axis-personal-note">{t("axis.history.empty")}</p>}
      <nav className="axis-personal-pagination" aria-label={t("axis.history.pagination")}><button type="button" className="ghost-button" disabled={historyPending || page === 1} onClick={() => setPage(value => value - 1)}>{t("axis.history.previous")}</button><span role="status">{t("axis.history.page", { page: number(data.history.page), pages: number(data.history.pages), n: number(data.history.total) })}</span><button type="button" className="ghost-button" disabled={historyPending || page >= data.history.pages} onClick={() => setPage(value => value + 1)}>{t("axis.history.next")}</button></nav>
    </section>
    <div className="axis-personal-bottom">
      {data.maps.length > 0 && <section className="axis-personal-section"><h2 className="section-heading">{t("axis.profile.maps")}</h2><div className="axis-personal-maps">{data.maps.map(map => <div key={map.name}><strong>{map.name}</strong><span>{t("axis.profile.mapRecord", { n: map.games, wins: map.wins })}</span><strong>{percent(map.winrate)}</strong></div>)}</div></section>}
      <section className="axis-personal-section"><h2 className="section-heading">{t(season === "all" ? "axis.profile.story.all" : "axis.profile.story.title")}</h2><p className="axis-personal-note">{t("axis.profile.story.source", { n: AXIS_STORY_MAP_MIN_MATCHES })}</p>
        <div className="axis-personal-story">
          {data.story.mostWinsWith && <article><h3>{t("axis.profile.story.mostWins")}</h3><PlayerName player={data.story.mostWinsWith} /><p>{t("axis.profile.story.jointWins", { n: number(data.story.mostWinsWith.wins) })}</p></article>}
          {data.story.revenge && <article><h3>{t("axis.profile.story.revenge")}</h3><PlayerName player={data.story.revenge.opponent} /><p>{t("axis.profile.story.lossRun", { n: number(data.story.revenge.losses) })} <Link href={axisMatchHref(data.story.revenge.matchNumber)} prefetch={false}>{t("axis.history.match", { n: data.story.revenge.matchNumber })}</Link></p></article>}
          {data.story.bestMap && <article><h3>{t("axis.profile.story.bestMap")}</h3><strong>{data.story.bestMap.name} · {percent(data.story.bestMap.winrate)}</strong><p>{t("axis.profile.mapRecord", { n: data.story.bestMap.games, wins: data.story.bestMap.wins })}</p></article>}
          {!data.story.mostWinsWith && !data.story.revenge && !data.story.bestMap && <p className="axis-personal-note">{t("axis.profile.story.empty")}</p>}
        </div>
      </section>
    </div>
    <p className="axis-personal-source">{t("axis.profile.source")}{data.updatedAt != null && <> · {t("axis.updated", { time: new Date(data.updatedAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) })}</>}</p>
  </div>;
}
