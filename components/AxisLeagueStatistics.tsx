"use client";

import { useEffect, useMemo, useState } from "react";
import AxisPlayerIdentity, { AxisAvatar } from "./AxisPlayerIdentity";
import type { AxisPlayer } from "@/lib/axis-league";
import { useI18n } from "@/lib/i18n/context";
import "./axis-statistics.css";

type Award = { playerId: string; value: number } | null;
type Party = { players: string[]; games: number; wins: number; winRate: number } | null;
type Stats = {
  available: boolean;
  archiveComplete: boolean;
  updatedAt: number;
  season: string;
  seasons: { id: string; startsAt: number; endsAt: number | null }[];
  players: Record<string, { name: string; avatarUrl: string | null }>;
  awards: {
    mvp: Award; consistent: Award; party: Party; streak: Award;
    winMachine: Award; veteran: Award; rising: Award; duo: Party; cursed: Award;
    nemesis: { players: string[]; games: number; wins: number[] } | null;
    giantSlayer: Award;
  };
  totals: { players: number; matches: number; averageGames: number; active7d: number; lineups: number; peakDay: number };
  activity: { date: string; matches: number; players: number }[];
  distribution: number[];
  recentForm: { playerId: string; wins: number; losses: number; results: string[] }[];
};

const words = {
  en: {
    title: "League Statistics", spotlight: "Season spotlight", champions: "Hall of champions",
    records: "Season records", overall: "League at a glance", analytics: "Behind the numbers",
    form: "Recent form", stories: "Stories of the season", season: "Season",
    mvp: "Season MVP", consistent: "Mr. Consistent", party: "Dream team", streak: "Unstoppable",
    machine: "Win machine", veteran: "The veteran", rising: "Rising star",
    duo: "Dynamic duo", cursed: "Cursed player", nemesis: "Nemesis", slayer: "Giant slayer",
    players: "Unique players", matches: "Total matches", average: "Matches per player",
    active: "Active · 7 days", lineups: "Unique lineups", peak: "Peak day",
    activity: "League activity", distribution: "Win rate distribution",
    gamesTogether: "matches together", wins: "wins in a row", losses: "losses in a row",
    personal: "Personal bests", results: "Last 10 matches", headToHead: "head-to-head matches",
    upsets: "underdog victories", mmr: "MMR gained", score: "MVP score", consistency: "Consistency",
    minMatches: "20+ games required", incomplete: "Archive syncing · results may change",
    empty: "Not enough recorded matches yet", loading: "Loading season statistics…",
    error: "Statistics are temporarily unavailable.", retry: "Retry", eligible: "10+ matches",
    period7: "7 days", period30: "30 days", periodAll: "Season", noData: "—",
    activePlayers: "Active players", noPlayers: "No eligible players",
    seasonNote: "Season awards and records from recorded matches", formNote: "Latest match is on the right",
  },
  ru: {
    title: "Статистика лиги", spotlight: "Главные награды", champions: "Герои сезона",
    records: "Рекорды сезона", overall: "Лига в цифрах", analytics: "Аналитика",
    form: "Последние результаты", stories: "Истории сезона", season: "Сезон",
    mvp: "MVP сезона", consistent: "Самый стабильный", party: "Лучшее пати", streak: "Без остановки",
    machine: "Машина побед", veteran: "Ветеран", rising: "Прорыв сезона",
    duo: "Лучший дуэт", cursed: "Серия неудач", nemesis: "Nemesis", slayer: "Giant slayer",
    players: "Уникальные игроки", matches: "Матчи", average: "Матчей на игрока",
    active: "Активны за 7 дней", lineups: "Составы пати", peak: "Пик активности",
    activity: "Активность лиги", distribution: "Распределение винрейта",
    gamesTogether: "совместных матчей", wins: "побед подряд", losses: "поражений подряд",
    personal: "Личные достижения", results: "Последние 10 матчей", headToHead: "очных встреч",
    upsets: "побед над фаворитами", mmr: "Прирост MMR", score: "Очки MVP", consistency: "Стабильность",
    minMatches: "Минимум 20 игр", incomplete: "Архив обновляется · результаты могут измениться",
    empty: "Пока недостаточно завершённых матчей", loading: "Загружаем статистику лиги…",
    error: "Статистика временно недоступна.", retry: "Повторить", eligible: "От 10 матчей",
    period7: "7 дней", period30: "30 дней", periodAll: "Сезон", noData: "—",
    activePlayers: "Активные игроки", noPlayers: "Недостаточно данных",
    seasonNote: "Награды и рекорды по сохранённым матчам", formNote: "Последний матч справа",
  },
};
type Phrase = keyof typeof words.en;

function ActivityChart({ rows, locale, players, period }: {
  rows: Stats["activity"]; locale: string; players: boolean; period: number;
}) {
  const selected = period ? rows.slice(-period) : rows;
  if (!selected.length) return <div className="axis-stat-empty">—</div>;
  const values = selected.map((point) => players ? point.players : point.matches);
  const maximum = Math.max(1, ...values);
  const x = (index: number) => selected.length === 1 ? 250 : 28 + index * 444 / (selected.length - 1);
  const y = (value: number) => 175 - value / maximum * 142;
  const coords = values.map((value, index) => [x(index), y(value)] as const);
  const points = coords.map(([a, b]) => a + "," + b).join(" ");
  const area = "M" + coords.map(([a, b]) => a + " " + b).join(" L") + " L" + coords[coords.length - 1][0] + " 175 L" + coords[0][0] + " 175 Z";
  return <div className="axis-stat-activity-chart">
    <svg viewBox="0 0 500 195" preserveAspectRatio="none" role="img" aria-label={players ? words.en.activePlayers : words.en.activity}>
      {[0, 1, 2, 3, 4].map((i) => <line key={i} x1="28" x2="472" y1={175 - i * 35.5} y2={175 - i * 35.5} stroke="var(--card-border)" strokeDasharray="3 5" />)}
      <path d={area} fill="var(--axis-stat-chart-fill)" />
      <polyline points={points} fill="none" stroke="var(--axis-stat-gold)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {coords.map(([a, b], index) => <circle key={selected[index].date} cx={a} cy={b} r="3" fill="var(--axis-stat-gold)">
        <title>{selected[index].date + ": " + values[index].toLocaleString(locale)}</title>
      </circle>)}
    </svg>
    <div className="axis-stat-axis"><span>{selected[0].date}</span><span>{selected[selected.length - 1].date}</span></div>
  </div>;
}

export default function AxisLeagueStatistics({ players, averageKda }: { players?: AxisPlayer[]; averageKda?: number | null }) {
  const { lang } = useI18n();
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const t = (key: Phrase) => words[lang === "ru" ? "ru" : "en"][key];
  const [season, setSeason] = useState("current");
  const [statistics, setStatistics] = useState<Stats | null>(null);
  const [seasons, setSeasons] = useState<Stats["seasons"]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [period, setPeriod] = useState(30);
  const [showPlayers, setShowPlayers] = useState(false);
  const [selectedBin, setSelectedBin] = useState<number | null>(null);
  const leaderboard = useMemo(() => new Map((players ?? []).map((p) => [p.id, p])), [players]);

  useEffect(() => {
    const controller = new AbortController();
    setStatistics(null);
    setError(false);
    void (async () => {
      try {
        const response = await fetch("/api/axis-league/statistics?season=" + encodeURIComponent(season), {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error("Statistics unavailable");
        const body = await response.json() as Stats;
        if (!body?.available || body.season !== season || !Array.isArray(body.activity)) throw new Error("Invalid statistics");
        if (!controller.signal.aborted) {
          setStatistics(body);
          setSeasons(body.seasons);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, [season, retry]);

  const number = (v: number, digits = 0) => v.toLocaleString(locale, { maximumFractionDigits: digits });
  const percent = (v: number) => number(v, 1) + "%";
  function player(id: string) {
    const person = statistics?.players[id];
    if (!person) return <span className="axis-stat-unknown">{t("noPlayers")}</span>;
    const current = season === "current" ? leaderboard.get(id) : undefined;
    return current
      ? <AxisPlayerIdentity player={current} mmr={current.mmr} averageKda={averageKda ?? null} />
      : <span className="axis-stat-identity"><AxisAvatar name={person.name} url={person.avatarUrl} /><strong>{person.name}</strong></span>;
  }
  function personIds(ids: string[]) {
    return <div className="axis-stat-party-names">{ids.map((id) => <span key={id}>{player(id)}</span>)}</div>;
  }
  function awardValue(award: Award, suffix = "", digits = 0) {
    return award ? number(award.value, digits) + suffix : "—";
  }
  const main = statistics?.awards;
  const recordCards: { id: string; title: Phrase; symbol: string; suffix: string; digits?: number; note: Phrase }[] = [
    { id: "winMachine", title: "machine", symbol: "♛", suffix: "%", digits: 1, note: "minMatches" },
    { id: "veteran", title: "veteran", symbol: "◷", suffix: "", note: "matches" },
    { id: "rising", title: "rising", symbol: "↗", suffix: " MMR", note: "mmr" },
    { id: "duo", title: "duo", symbol: "♢", suffix: "%", digits: 1, note: "gamesTogether" },
    { id: "cursed", title: "cursed", symbol: "☠", suffix: " L", note: "losses" },
  ];
  const summary: { key: keyof Stats["totals"]; name: Phrase; digits?: number }[] = [
    { key: "players", name: "players" }, { key: "matches", name: "matches" },
    { key: "averageGames", name: "average", digits: 1 }, { key: "active7d", name: "active" },
    { key: "lineups", name: "lineups" }, { key: "peakDay", name: "peak" },
  ];
  const bins = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];
  const distribution = statistics?.distribution ?? [];
  const maxBin = Math.max(1, ...distribution);

  return <section className="axis-statistics" aria-label={t("title")}>
    <div className="axis-stat-topline">
      <div><span className="axis-stat-eyebrow">AXIS LEAGUE / STATISTICS</span><h2>{t("title")}</h2><p>{t("seasonNote")}</p></div>
      <label className="axis-stat-season">{t("season")}<select value={season} onChange={(event) => setSeason(event.target.value)}>
        {(seasons.length ? seasons : [{ id: "current", startsAt: 0, endsAt: null }]).map((item) =>
          <option value={item.id} key={item.id}>{item.id === "current" ? t("season") + " · Current" : new Date(item.startsAt).toLocaleDateString(locale, { month: "short", year: "numeric" })}</option>)}
      </select></label>
    </div>
    {!statistics && <div className="axis-stat-status" role="status">{error ? t("error") : t("loading")}
      {error && <button className="ghost-button" type="button" onClick={() => setRetry((v) => v + 1)}>{t("retry")}</button>}
    </div>}
    {statistics && <>
      {!statistics.archiveComplete && <p className="axis-stat-warning" role="status">{t("incomplete")}</p>}
      {statistics.totals.matches === 0 && <p className="axis-stat-status">{t("empty")}</p>}
      <div className="axis-stat-section-heading"><div><span className="axis-stat-eyebrow">01 / SEASON SPOTLIGHT</span><h3>{t("champions")}</h3></div></div>
      <div className="axis-stat-heroes">
        <article className="axis-stat-hero axis-stat-hero--mvp">
          <div className="axis-stat-hero-top"><span>✦ {t("mvp")}</span><small>01 / 04</small></div>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{main?.mvp ? number(main.mvp.value) : "—"}</div><small>{t("score")}</small><div className="axis-stat-hero-player">{main?.mvp ? player(main.mvp.playerId) : t("noPlayers")}</div></div>
        </article>
        <article className="axis-stat-hero axis-stat-hero--consistent">
          <div className="axis-stat-hero-top"><span>◇ {t("consistent")}</span><small>02 / 04</small></div>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{awardValue(main?.consistent ?? null, "%", 1)}</div><small>{t("consistency")}</small><div className="axis-stat-hero-player">{main?.consistent ? player(main.consistent.playerId) : t("noPlayers")}</div></div>
        </article>
        <article className="axis-stat-hero">
          <div className="axis-stat-hero-top"><span>♢ {t("party")}</span><small>03 / 04</small></div>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{main?.party ? percent(main.party.winRate) : "—"}</div><small>{main?.party ? number(main.party.games) + " " + t("gamesTogether") : t("noPlayers")}</small>{main?.party && personIds(main.party.players)}</div>
        </article>
        <article className="axis-stat-hero">
          <div className="axis-stat-hero-top"><span>↗ {t("streak")}</span><small>04 / 04</small></div>
          <div className="axis-stat-hero-body"><div className="axis-stat-hero-number">{awardValue(main?.streak ?? null)}</div><small>{t("wins")}</small><div className="axis-stat-hero-player">{main?.streak ? player(main.streak.playerId) : t("noPlayers")}</div></div>
        </article>
      </div>

      <div className="axis-stat-section-heading"><div><span className="axis-stat-eyebrow">02 / PERSONAL BESTS</span><h3>{t("records")}</h3></div></div>
      <div className="axis-stat-records">{recordCards.map((record) => {
        const prize = main?.[record.id as "winMachine" | "veteran" | "rising" | "duo" | "cursed"] ?? null;
        const group = record.id === "duo" ? main?.duo : null;
        const single = record.id !== "duo" ? prize as Award : null;
        const val = group ? number(group.winRate, 1) + "%" : awardValue(single, record.suffix, record.digits ?? 0);
        return <article key={record.id} className="axis-stat-record"><div className="axis-stat-record-icon">{record.symbol}</div><h4>{t(record.title)}</h4>
          <strong className="axis-stat-record-value">{val}</strong>
          <div className="axis-stat-record-name">{group ? personIds(group.players) : single ? player(single.playerId) : <span>—</span>}</div>
          <small>{group ? number(group.games) + " " + t("gamesTogether") : t(record.note)}</small>
        </article>;
      })}</div>

      <div className="axis-stat-section-heading"><div><span className="axis-stat-eyebrow">03 / THE BIG PICTURE</span><h3>{t("overall")}</h3></div></div>
      <div className="axis-stat-totals">{summary.map((item) => <div className="axis-stat-total" key={item.key}><span>{t(item.name)}</span><strong>{number(statistics.totals[item.key], item.digits ?? 0)}</strong></div>)}</div>

      <div className="axis-stat-section-heading"><div><span className="axis-stat-eyebrow">04 / ANALYTICS</span><h3>{t("analytics")}</h3></div></div>
      <div className="axis-stat-charts">
        <article className="axis-stat-panel">
          <div className="axis-stat-panel-head"><h4>{t("activity")}</h4><div className="axis-stat-switch">
            {([7, 30, 0] as const).map((p) => <button type="button" key={p} className={period === p ? "is-active" : ""} aria-pressed={period === p} onClick={() => setPeriod(p)}>{p === 7 ? "7D" : p === 30 ? "30D" : t("periodAll")}</button>)}
          </div></div>
          <div className="axis-stat-switch axis-stat-metric">
            <button type="button" className={!showPlayers ? "is-active" : ""} aria-pressed={!showPlayers} onClick={() => setShowPlayers(false)}>{t("matches")}</button>
            <button type="button" className={showPlayers ? "is-active" : ""} aria-pressed={showPlayers} onClick={() => setShowPlayers(true)}>{t("activePlayers")}</button>
          </div>
          <ActivityChart rows={statistics.activity} locale={locale} players={showPlayers} period={period} />
        </article>
        <article className="axis-stat-panel">
          <div className="axis-stat-panel-head"><h4>{t("distribution")}</h4><small>{t("eligible")}</small></div>
          <div className="axis-stat-bars">{bins.map((bin, index) => <button key={bin} type="button" className={selectedBin === index ? "is-active" : ""} title={bin + " · " + number(distribution[index] ?? 0)} onClick={() => setSelectedBin(selectedBin === index ? null : index)}>
            <span>{number(distribution[index] ?? 0)}</span><i style={{ height: Math.max(3, (distribution[index] ?? 0) / maxBin * 100) + "%" }} /><small>{bin.replace("%", "")}</small>
          </button>)}</div>
          <div className="axis-stat-bin-detail">{selectedBin == null ? t("eligible") : bins[selectedBin] + " · " + number(distribution[selectedBin] ?? 0) + " " + t("players")}</div>
        </article>
      </div>

      <div className="axis-stat-section-heading"><div><span className="axis-stat-eyebrow">05 / PLAYER MOMENTUM</span><h3>{t("form")}</h3></div><small>{t("formNote")}</small></div>
      <div className="axis-stat-form">
        {statistics.recentForm.length ? statistics.recentForm.map((entry) => <div className="axis-stat-form-row" key={entry.playerId}>
          <div className="axis-stat-form-name">{player(entry.playerId)}</div><strong>{number(entry.wins * 10)}%</strong>
          <div className="axis-stat-squares">{entry.results.map((result, index) =>
            <span key={index} title={"Match " + (index + 1) + " · " + result} className={result === "W" ? "win" : "loss"}>{result}</span>)}</div>
        </div>) : <div className="axis-stat-status">{t("noPlayers")}</div>}
      </div>

      <div className="axis-stat-section-heading"><div><span className="axis-stat-eyebrow">06 / RIVALRIES & UPSETS</span><h3>{t("stories")}</h3></div></div>
      <div className="axis-stat-stories">
        <article className="axis-stat-panel"><h4>⚔ {t("nemesis")}</h4>
          {main?.nemesis ? <>
            <div className="axis-stat-duel"><div>{player(main.nemesis.players[0])}</div><strong>{main.nemesis.wins[0]} : {main.nemesis.wins[1]}</strong><div>{player(main.nemesis.players[1])}</div></div>
            <p>{number(main.nemesis.games)} {t("headToHead")}</p>
          </> : <p>{t("noPlayers")}</p>}
        </article>
        <article className="axis-stat-panel"><h4>✦ {t("slayer")}</h4>
          {main?.giantSlayer ? <div className="axis-stat-slayer"><strong>{number(main.giantSlayer.value)}</strong><div>{player(main.giantSlayer.playerId)}<p>{t("upsets")}</p></div></div> : <p>{t("noPlayers")}</p>}
        </article>
      </div>
    </>}
  </section>;
}
