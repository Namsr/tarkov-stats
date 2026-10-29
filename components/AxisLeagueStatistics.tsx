"use client";

import { useEffect, useMemo, useState } from "react";
import AxisPlayerIdentity, { AxisAvatar } from "./AxisPlayerIdentity";
import type { AxisPlayer } from "@/lib/axis-league";
import { useI18n } from "@/lib/i18n/context";
import "./axis-statistics.css";

type Award = { playerId: string; value: number } | null;
type Party = { players: string[]; games: number; wins: number; winRate: number } | null;
type Stats = {
  available: boolean; archiveComplete: boolean; updatedAt: number; season: string;
  seasons: { id: string; startsAt: number; endsAt: number | null }[];
  players: Record<string, { name: string; avatarUrl: string | null }>;
  awards: {
    mvp: Award; consistent: Award; party: Party; streak: Award;
    winMachine: Award; veteran: Award;
    rising: { playerId: string; value: number; fromMmr: number; toMmr: number } | null;
    duo: Party; cursed: Award;
    nemesis: { players: string[]; games: number; wins: number[] } | null; giantSlayer: Award;
  };
  totals: { players: number; matches: number; averageGames: number; active7d: number; lineups: number; peakDay: number; peakDayDate: string | null };
  activity: { date: string; matches: number; players: number }[];
  distribution: number[];
  ratingDistribution: { from: number; to: number; players: number }[];
  recentForm: { playerId: string; wins: number; losses: number; results: string[] }[];
};

function ActivityChart({ rows, locale, players, period }: {
  rows: Stats["activity"]; locale: string; players: boolean; period: number;
}) {
  const { t } = useI18n();
  const selected = period ? rows.slice(-period) : rows;
  if (!selected.length) return <div className="axis-stat-status">{t("axis.stats.empty")}</div>;
  const values = selected.map((point) => players ? point.players : point.matches);
  const peak = Math.max(1, ...values);
  const roughStep = peak / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, roughStep)));
  const step = [1, 2, 5, 10].find((n) => n * magnitude >= roughStep)! * magnitude;
  const tickCount = Math.ceil(peak / step);
  const maximum = tickCount * step;
  const plotWidth = Math.max(240, (selected.length - 1) * 40);
  const width = plotWidth + 68;
  const x = (index: number) => 50 + (selected.length === 1 ? plotWidth / 2 : index * plotWidth / (selected.length - 1));
  const y = (value: number) => 192 - value / maximum * 152;
  const coords = values.map((value, index) => [x(index), y(value)] as const);
  const points = coords.map(([a, b]) => a + "," + b).join(" ");
  const area = "M" + coords.map(([a, b]) => a + " " + b).join(" L") + " L" + coords.at(-1)![0] + " 192 L" + coords[0][0] + " 192 Z";
  const metric = players ? t("axis.stats.activePlayers") : t("axis.stats.matches");
  const date = (value: string) => value.slice(8, 10) + "/" + value.slice(5, 7);
  return <>
    <div className="axis-stat-activity-chart" tabIndex={0} role="region" aria-label={t("axis.stats.chartLabel", { metric })}>
      <svg viewBox={`0 0 ${width} 230`} style={{ minWidth: width }} role="img" aria-label={t("axis.stats.chartLabel", { metric })}>
        <text x="0" y="17" className="axis-stat-chart-label">{metric}</text>
        {Array.from({ length: tickCount + 1 }, (_, i) => <g key={i}>
          <line x1="50" x2={width - 18} y1={y(i * step)} y2={y(i * step)} className="axis-stat-gridline" />
          <text x="40" y={y(i * step) + 4} textAnchor="end" className="axis-stat-chart-label">{(i * step).toLocaleString(locale)}</text>
        </g>)}
        <path d={area} fill="var(--axis-stat-chart-fill)" />
        <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {selected.map((point, index) => {
          const yearChanged = index > 0 && point.date.slice(0, 4) !== selected[index - 1].date.slice(0, 4);
          const separator = index === 0 ? 50 : (x(index - 1) + x(index)) / 2;
          return <g key={point.date}>
            {(index === 0 || yearChanged) && <>
              {yearChanged && <line x1={separator} x2={separator} y1="28" y2="218" className="axis-stat-year-line" />}
              <text x={separator + 3} y="31" className="axis-stat-year">{point.date.slice(0, 4)}</text>
            </>}
            <circle cx={x(index)} cy={y(values[index])} r="3" fill="var(--accent)" tabIndex={0}
              role="img" aria-label={point.date + ": " + values[index].toLocaleString(locale) + " · " + metric}>
              <title>{point.date + ": " + values[index].toLocaleString(locale) + " · " + metric}</title>
            </circle>
            <text x={x(index)} y="214" textAnchor="middle" className="axis-stat-chart-label">{date(point.date)}</text>
          </g>;
        })}
      </svg>
    </div>
    <details className="axis-stat-chart-data"><summary>{t("axis.stats.chartData")}</summary>
      <table><thead><tr><th scope="col">{t("axis.stats.date")}</th><th scope="col">{metric}</th></tr></thead>
        <tbody>{selected.map((point, index) => <tr key={point.date}><th scope="row">{point.date}</th><td>{values[index].toLocaleString(locale)}</td></tr>)}</tbody>
      </table>
    </details>
  </>;
}

export default function AxisLeagueStatistics({ players, averageKda }: { players?: AxisPlayer[]; averageKda?: number | null }) {
  const { t, lang } = useI18n();
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const [season, setSeason] = useState("current");
  const [statistics, setStatistics] = useState<Stats | null>(null);
  const [seasons, setSeasons] = useState<Stats["seasons"]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [period, setPeriod] = useState(30);
  const [showPlayers, setShowPlayers] = useState(false);
  const [distributionMetric, setDistributionMetric] = useState<"rating" | "winrate">("rating");
  const [selectedBin, setSelectedBin] = useState<number | null>(null);
  const leaderboard = useMemo(() => new Map((players ?? []).map((p) => [p.id, p])), [players]);

  useEffect(() => {
    const controller = new AbortController();
    setStatistics(null);
    setSelectedBin(null);
    setError(false);
    void (async () => {
      try {
        const response = await fetch("/api/axis-league/statistics?season=" + encodeURIComponent(season), {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error("Statistics unavailable");
        const body = await response.json() as Stats;
        if (!body?.available || body.season !== season || !Array.isArray(body.activity) || !Array.isArray(body.ratingDistribution)) throw new Error("Invalid statistics");
        if (!controller.signal.aborted) { setStatistics(body); setSeasons(body.seasons); }
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [season, retry]);

  const number = (v: number, digits = 0) => v.toLocaleString(locale, { maximumFractionDigits: digits });
  const percent = (v: number) => number(v, 1) + "%";
  function player(id: string) {
    const person = statistics?.players[id];
    if (!person) return <span className="axis-stat-unknown">{t("axis.stats.noPlayers")}</span>;
    const current = season === "current" ? leaderboard.get(id) : undefined;
    return current ? <AxisPlayerIdentity player={current} mmr={current.mmr} averageKda={averageKda ?? null} />
      : <span className="axis-stat-identity"><AxisAvatar name={person.name} url={person.avatarUrl} /><strong>{person.name}</strong></span>;
  }
  function personIds(ids: string[]) {
    return <div className="axis-stat-party-names">{ids.map((id) => <span key={id}>{player(id)}</span>)}</div>;
  }
  function awardValue(award: Award, suffix = "", digits = 0) { return award ? number(award.value, digits) + suffix : "—"; }
  const main = statistics?.awards;
  const recordCards = [
    { id: "winMachine", title: "axis.stats.machine", symbol: "♛", suffix: "%", digits: 1, note: "axis.stats.minMatches" },
    { id: "veteran", title: "axis.stats.veteran", symbol: "◷", suffix: "", digits: 0, note: "axis.stats.matches" },
    { id: "rising", title: "axis.stats.rising", symbol: "↗", suffix: "", digits: 0, note: "axis.column.mmr" },
    { id: "duo", title: "axis.stats.duo", symbol: "♢", suffix: "%", digits: 1, note: "axis.stats.gamesTogether" },
    { id: "cursed", title: "axis.stats.cursed", symbol: "☠", suffix: " L", digits: 0, note: "axis.stats.losses" },
  ] as const;
  const summary = [
    { key: "players", name: "axis.stats.players", digits: 0 }, { key: "matches", name: "axis.stats.matches", digits: 0 },
    { key: "averageGames", name: "axis.stats.average", digits: 1 }, { key: "active7d", name: "axis.stats.active", digits: 0 },
    { key: "lineups", name: "axis.stats.lineups", digits: 0 }, { key: "peakDay", name: "axis.stats.peak", digits: 0 },
  ] as const;
  const bins = distributionMetric === "rating"
    ? (statistics?.ratingDistribution ?? []).map((bin) => ({ label: number(bin.from) + "–" + number(bin.to), count: bin.players }))
    : (statistics?.distribution ?? []).map((count, index) => ({ label: `${index * 20}–${(index + 1) * 20}%`, count }));
  const maxBin = Math.max(1, ...bins.map((bin) => bin.count));
  const binDetail = selectedBin === null ? null : bins[selectedBin];

  return <section className="axis-statistics" aria-label={t("axis.stats.title")}>
    <div className="axis-stat-topline"><h2>{t("axis.stats.title")}</h2>
      <label className="axis-stat-season">{t("axis.stats.season")}<select value={season} onChange={(event) => setSeason(event.target.value)}>
        {(seasons.length ? seasons : [{ id: "current", startsAt: 0, endsAt: null }]).map((item) => <option value={item.id} key={item.id}>
          {item.id === "current" ? t("axis.season.current") : new Date(item.startsAt).toLocaleDateString(locale, { month: "short", year: "numeric" })}
        </option>)}
      </select></label>
    </div>
    {!statistics && <div className="axis-stat-status" role="status">{error ? t("axis.stats.error") : t("common.loading")}
      {error && <button className="ghost-button" type="button" onClick={() => setRetry((v) => v + 1)}>{t("axis.stats.retry")}</button>}
    </div>}
    {statistics && <>
      {!statistics.archiveComplete && <p className="axis-stat-warning" role="status">{t("axis.stats.incomplete")}</p>}
      {statistics.totals.matches === 0 && <p className="axis-stat-status">{t("axis.stats.empty")}</p>}
      <div className="axis-stat-section-heading"><h3>{t("axis.stats.champions")}</h3></div>
      <div className="axis-stat-heroes">
        <article className="axis-stat-hero axis-stat-hero--mvp">
          <h4 className="axis-stat-hero-top">✦ {t("axis.stats.mvp")}</h4>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{awardValue(main?.mvp ?? null)}</div><small>{t("axis.stats.score")}</small><div className="axis-stat-hero-player">{main?.mvp ? player(main.mvp.playerId) : t("axis.stats.noPlayers")}</div></div>
        </article>
        <article className="axis-stat-hero axis-stat-hero--consistent">
          <h4 className="axis-stat-hero-top">◇ {t("axis.stats.consistent")}</h4>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{awardValue(main?.consistent ?? null, "%", 1)}</div><div className="axis-stat-hero-player">{main?.consistent ? player(main.consistent.playerId) : t("axis.stats.noPlayers")}</div></div>
        </article>
        <article className="axis-stat-hero"><h4 className="axis-stat-hero-top">♢ {t("axis.stats.party")}</h4>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{main?.party ? percent(main.party.winRate) : "—"}</div><small>{main?.party ? t("axis.stats.sharedMatches", { n: number(main.party.games) }) : t("axis.stats.noPlayers")}</small>{main?.party && personIds(main.party.players)}</div>
        </article>
        <article className="axis-stat-hero"><h4 className="axis-stat-hero-top">↗ {t("axis.stats.streak")}</h4>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{awardValue(main?.streak ?? null)}</div><small>{t("axis.stats.wins")}</small><div className="axis-stat-hero-player">{main?.streak ? player(main.streak.playerId) : t("axis.stats.noPlayers")}</div></div>
        </article>
      </div>
      <div className="axis-stat-section-heading"><h3>{t("axis.stats.records")}</h3></div>
      <div className="axis-stat-records">{recordCards.map((record) => {
        const group = record.id === "duo" ? main?.duo : null;
        const single = record.id !== "duo" ? main?.[record.id] ?? null : null;
        const winrate = record.id === "winMachine" || record.id === "duo";
        return <article key={record.id} className={`axis-stat-record${record.id === "cursed" ? " axis-stat-record--loss" : ""}`}>
          <div className="axis-stat-record-icon" aria-hidden="true">{record.symbol}</div><h4>{t(record.title)}</h4>
          {record.id === "rising" && main?.rising
            ? <strong className="axis-stat-record-value axis-stat-rating-change">{number(main.rising.fromMmr)} → {number(main.rising.toMmr)} <small>{t("axis.column.mmr")}</small></strong>
            : <strong className="axis-stat-record-value">{group ? percent(group.winRate) : awardValue(single, record.suffix, record.digits)}{winrate && <small>{t("arena.metric.win_rate")}</small>}</strong>}
          <div className="axis-stat-record-name">{group ? personIds(group.players) : single ? player(single.playerId) : <span>—</span>}</div>
          <small>{group ? t("axis.stats.sharedMatches", { n: number(group.games) }) : record.id === "rising" ? "" : t(record.note)}</small>
        </article>;
      })}</div>
      <div className="axis-stat-section-heading"><h3>{t("axis.stats.overall")}</h3></div>
      <div className="axis-stat-totals">{summary.map((item) => <div className="axis-stat-total" key={item.key}>
        <span>{t(item.name)}</span><strong>{number(statistics.totals[item.key], item.digits)}</strong>
        {item.key === "lineups" && <small>{t("axis.stats.lineupsNote")}</small>}
        {item.key === "peakDay" && statistics.totals.peakDayDate && <small>{new Date(statistics.totals.peakDayDate + "T00:00:00Z").toLocaleDateString(locale, { timeZone: "UTC" })}</small>}
      </div>)}</div>
      <div className="axis-stat-section-heading"><h3>{t("axis.stats.analytics")}</h3></div>
      <div className="axis-stat-charts">
        <article className="axis-stat-panel">
          <div className="axis-stat-panel-head"><h4>{t("axis.stats.activity")}</h4><div className="axis-stat-switch">
            {([7, 30, 0] as const).map((p) => <button type="button" key={p} className={period === p ? "is-active" : ""} aria-pressed={period === p} onClick={() => setPeriod(p)}>{p ? t("axis.stats.days", { n: p }) : t("axis.stats.season")}</button>)}
          </div></div>
          <div className="axis-stat-switch axis-stat-metric">
            <button type="button" className={!showPlayers ? "is-active" : ""} aria-pressed={!showPlayers} onClick={() => setShowPlayers(false)}>{t("axis.stats.matches")}</button>
            <button type="button" className={showPlayers ? "is-active" : ""} aria-pressed={showPlayers} onClick={() => setShowPlayers(true)}>{t("axis.stats.activePlayers")}</button>
          </div>
          <ActivityChart rows={statistics.activity} locale={locale} players={showPlayers} period={period} />
        </article>
        <article className="axis-stat-panel">
          <div className="axis-stat-panel-head"><h4>{t(distributionMetric === "rating" ? "axis.stats.ratingDistribution" : "axis.stats.winrateDistribution")}</h4><small>{t("axis.stats.eligible")}</small></div>
          <div className="axis-stat-switch axis-stat-metric">
            {(["rating", "winrate"] as const).map((metric) => <button type="button" key={metric} className={distributionMetric === metric ? "is-active" : ""} aria-pressed={distributionMetric === metric} onClick={() => { setDistributionMetric(metric); setSelectedBin(null); }}>{t(metric === "rating" ? "axis.column.mmr" : "arena.metric.win_rate")}</button>)}
          </div>
          {bins.length ? <div className="axis-stat-bars">{bins.map((bin, index) => <button key={bin.label} type="button" className={selectedBin === index ? "is-active" : ""} aria-pressed={selectedBin === index}
            aria-label={t("axis.stats.bucket", { range: bin.label, n: number(bin.count) })} onClick={() => setSelectedBin(selectedBin === index ? null : index)}>
            <span>{number(bin.count)}</span><i style={{ height: Math.max(3, bin.count / maxBin * 146) }} aria-hidden="true" /><small>{bin.label}</small>
          </button>)}</div> : <div className="axis-stat-status">{t("axis.stats.noPlayers")}</div>}
          <div className="axis-stat-bin-detail" role="status">{binDetail ? t("axis.stats.bucket", { range: binDetail.label, n: number(binDetail.count) }) : t("axis.stats.distributionNote")}</div>
        </article>
      </div>
      <div className="axis-stat-section-heading"><h3>{t("axis.stats.form")}</h3><small>{t("axis.stats.formNote")}</small></div>
      <div className="axis-stat-form">
        {statistics.recentForm.length ? statistics.recentForm.map((entry) => <div className="axis-stat-form-row" key={entry.playerId}>
          <div className="axis-stat-form-name">{player(entry.playerId)}</div><strong>{number(entry.wins * 10)}%</strong>
          <div className="axis-stat-squares">{entry.results.map((result, index) => <span key={index}
            title={t("axis.stats.result", { n: index + 1, result: t(result === "W" ? "axis.preview.win" : "axis.preview.loss") })} className={result === "W" ? "win" : "loss"}>{result}</span>)}</div>
        </div>) : <div className="axis-stat-status">{t("axis.stats.noPlayers")}</div>}
      </div>
      <div className="axis-stat-section-heading"><h3>{t("axis.stats.stories")}</h3></div>
      <div className="axis-stat-stories">
        <article className="axis-stat-panel"><h4>⚔ {t("axis.stats.nemesis")}</h4>
          {main?.nemesis ? <><div className="axis-stat-duel"><div>{player(main.nemesis.players[0])}</div><strong>{main.nemesis.wins[0]} : {main.nemesis.wins[1]}</strong><div>{player(main.nemesis.players[1])}</div></div>
            <p>{t("axis.stats.headToHead", { n: number(main.nemesis.games) })}</p></> : <p>{t("axis.stats.noPlayers")}</p>}
        </article>
        <article className="axis-stat-panel"><h4>✦ {t("axis.stats.slayer")}</h4>
          {main?.giantSlayer ? <div className="axis-stat-slayer"><strong>{number(main.giantSlayer.value)}</strong><div>{player(main.giantSlayer.playerId)}<p>{t("axis.stats.upsets")}</p></div></div> : <p>{t("axis.stats.noPlayers")}</p>}
        </article>
      </div>
    </>}
  </section>;
}
