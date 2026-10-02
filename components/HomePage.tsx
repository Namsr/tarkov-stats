"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import AuthErrorBanner from "@/components/AuthErrorBanner";
import { arenaMetricValue, toArenaProfile } from "@/components/arena-ui";
import CheaterScore from "@/components/CheaterScore";
import ProfilePortrait from "@/components/ProfilePortrait";
import ProfilePrestige from "@/components/ProfilePrestige";
import SearchBar from "@/components/SearchBar";
import HomeComparison from "@/components/home/HomeComparison";
import HomeLeaderboard from "@/components/home/HomeLeaderboard";
import HomeProgress from "@/components/home/HomeProgress";
import { useI18n } from "@/lib/i18n/context";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import {
  HOME_EXAMPLE_AIDS,
  homeProfilePrestige,
  homeProfileSide,
  homeCohort,
  pickShowcaseAid,
  showcaseCohortRequest,
  showcaseMode,
  showcaseProfileHref,
  showcaseProfileRequest,
  showcaseTimelineCycle,
  type HomeCohort,
  type HomeProfile,
  type ShowcaseConfig,
} from "@/lib/home-showcase";
import { rarestAchievements } from "@/lib/profile-achievements";
import type { PublicIndexCoverage } from "@/lib/public-index-coverage";
import type { ArenaProfile } from "@/types/arena";
import type { ProfileViewAchievement } from "@/types/player-profile-view";
import { GAME_MODES, type GameMode, type ProgressionTimelineResponse } from "@/types/seasonal";
import "@/components/home/home.css";
import "@/components/profile.css";

/** Daily throughput is a static figure, not a live measurement: the sync runs at
 *  1 RPS per mode, so a real per-day count would swing with queue state and mean
 *  nothing to a visitor.
 *
 *  2 500 is the rounded seven-day mean of profile updates across all four
 *  upstream `updated.json` feeds (regular 768, PvE 511, arena 499, seasonal 794
 *  per day, measured 2026-10-01). These are four separate feeds of overlapping
 *  players, so it counts profile updates rather than distinct people. Recompute
 *  when re-baselining the copy; the total beside it is live and comes from the
 *  `row_count` the index sync writes at swap time (lib/public-index-coverage). */
const DAILY_SCAN_FIGURE = 2_500;

interface ShowcaseSnapshot {
  mode: GameMode;
  profile: HomeProfile | null;
  arena: ArenaProfile | null;
  timeline: ProgressionTimelineResponse | null;
  cohort: HomeCohort | null;
}

type ShowcaseProfileResponse = HomeProfile | {
  identity: HomeProfile["identity"];
  arena: ArenaProfile | null;
};

/** One row of artwork on the showcase card: the five rarest unlocks. */
const ACHIEVEMENT_ICON_COUNT = 5;

/** Only achievements with artwork can render an icon, so the picker gets a typed list. */
function achievementWithImage(item: ProfileViewAchievement): item is ProfileViewAchievement & { imageUrl: string } {
  return Boolean(item.imageUrl);
}

export default function HomePage() {
  const { t, lang } = useI18n();
  const [aid, setAid] = useState<number | null>(null);
  const [seasonalCycleId, setSeasonalCycleId] = useState<string | null>(null);
  const [mode, setMode] = useState<GameMode>("regular");
  const [snapshot, setSnapshot] = useState<ShowcaseSnapshot | null>(null);
  // null until the index coverage response lands, so the rail never flashes a
  // placeholder number and then swaps it for the real one.
  const [coverage, setCoverage] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The button records the URL it is retrying in a ref, not in state: the load
  // effect has to read it without depending on it, or clearing it after a mode
  // or cycle switch would re-run that effect a second time.
  const forceUrl = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function resolveShowcase() {
      try {
        const response = await fetch("/api/home/showcase", { cache: "no-store", signal: controller.signal });
        const config = response.ok ? await response.json() as ShowcaseConfig : null;
        if (!cancelled) {
          setAid(pickShowcaseAid(config));
          setSeasonalCycleId(config?.seasonalCycleId ?? null);
          setMode(showcaseMode(config));
        }
      } catch {
        if (!cancelled) setAid(pickShowcaseAid(null));
      }
    }
    void resolveShowcase();
    return () => { cancelled = true; controller.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/home/coverage", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() as Promise<PublicIndexCoverage> : null))
      .then((body) => setCoverage(typeof body?.total === "number" ? body.total : null))
      // The rail is decoration next to the search field: a failed read leaves the
      // daily figure alone and simply omits the total, so it must not throw.
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Named outside the effect so the retry button can ask for exactly this URL.
  const profileUrl = aid == null ? null : showcaseProfileRequest(mode, aid, seasonalCycleId);

  useEffect(() => {
    if (profileUrl == null || aid == null) return;
    // A 200 can carry a body this page cannot use, and that body stays in the
    // response cache for its whole TTL, so the load the retry button asked for
    // has to bypass the cache or it re-reads the same unusable payload and never
    // recovers. Every other URL is an ordinary load: forcing one would spend a
    // rate-limit slot on a switch that did not ask for it.
    const force = forceUrl.current === profileUrl;
    if (!force) forceUrl.current = null;
    let cancelled = false;
    const controller = new AbortController();
    const cycle = showcaseTimelineCycle(mode, seasonalCycleId);
    const cohortUrl = showcaseCohortRequest(mode, aid, seasonalCycleId);
    const loadProfile = async (): Promise<Pick<ShowcaseSnapshot, "profile" | "arena"> | null> => {
      try {
        const response = await loadPlayerProfileResponse<ShowcaseProfileResponse>(profileUrl, { force });
        const body = response.body;
        if (!response.ok || body.identity?.aid !== aid || body.identity.mode !== mode) return null;
        if (mode === "arena") {
          const arena = toArenaProfile(body, aid);
          return arena?.aid === aid ? { profile: null, arena } : null;
        }
        return "viewModel" in body && body.viewModel ? { profile: body, arena: null } : null;
      } catch { return null; }
    };
    async function load<T>(url: string): Promise<T | null> {
      try {
        const response = await fetch(url, { signal: controller.signal });
        return response.ok ? await response.json() as T : null;
      } catch { return null; }
    }
    void Promise.all([
      loadProfile(),
      cycle == null ? Promise.resolve(null)
        : load<ProgressionTimelineResponse>(`/api/progression/timeline?aid=${aid}&mode=${mode}&cycle=${cycle}`),
      cohortUrl == null ? Promise.resolve(null)
        : load<unknown>(cohortUrl).then(homeCohort),
    ]).then(([profileData, timeline, cohortData]) => {
      if (!cancelled) setSnapshot({ mode, profile: profileData?.profile ?? null, arena: profileData?.arena ?? null, timeline, cohort: cohortData });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [aid, mode, attempt, profileUrl, seasonalCycleId]);

  // Stale-while-revalidate: keep the previous mode's card on screen while the
  // next mode loads. Wiping to the loading panel collapses the section and
  // shifts the whole page on every switch. The stale snapshot keeps its own
  // mode for labels, values and links so data never mixes across modes.
  const current = snapshot && snapshot.mode === mode ? snapshot : null;
  const switching = current == null && snapshot != null;
  const display = current ?? snapshot;
  const displayMode: GameMode = display?.mode ?? mode;
  const view = display?.profile?.viewModel;
  const arena = display?.arena;
  const name = view?.identity.nickname ?? arena?.nickname ?? "";
  const side = homeProfileSide(display?.profile);
  const prestige = homeProfilePrestige(display?.profile, displayMode);
  const displayAid = aid ?? HOME_EXAMPLE_AIDS[0];
  const href = showcaseProfileHref(displayMode, displayAid, seasonalCycleId);
  const unavailable = display != null && display.profile == null && display.arena == null && !switching;
  const riskScorable = display?.profile?.comparisonStats?.pvpStatsKnown !== false;
  const n = (value: number | null | undefined, digits = 0) => value == null ? "—" : value.toLocaleString(lang, { maximumFractionDigits: digits });
  const sections = [
    ["stats", "profile.section.statistics"], ["progress", "home.progressShort"],
    ["risk", "home.riskTitle"], ["compare", "profile.section.comparison"], ["leaderboard", "leaderboard.title"],
  ];
  function heading(title: string, anchor: string, action: string) {
    return <div className="home-section-head"><h2>{t(title)}</h2><Link prefetch={false} className="home-text-link" href={`${href}#${anchor}`}>{t(action)}<span aria-hidden="true">↗</span></Link></div>;
  }

  return (
    <main className="home-page">
      <section className="home-search-hero" id="search">
        <div className="home-hero-art" aria-hidden="true"><Image src="/home/tarkov-key-art.webp" alt="" fill sizes="(max-width: 760px) 100vw, 70vw" preload /></div>
        <div className="home-wrap home-hero-inner">
          <AuthErrorBanner />
          <h1>{t("home.title")}<br />{t("home.game")}</h1>
          <SearchBar landing />
          <p className="home-scan-rail">
            <span className="home-scan-rail__item">
              <span className="home-scan-rail__note">{t("home.scanAbout")}</span>
              <strong className="home-scan-rail__value">{DAILY_SCAN_FIGURE.toLocaleString(lang)}</strong>
              <span className="home-scan-rail__caption">{t("home.scanPerDay")}</span>
            </span>
            {coverage !== null && (
              <span className="home-scan-rail__item">
                <strong className="home-scan-rail__value">{coverage.toLocaleString(lang)}</strong>
                <span className="home-scan-rail__caption">{t("home.scanTotal")}</span>
              </span>
            )}
          </p>
          <nav className="home-feature-links" aria-label={t("home.sections")}>
            {sections.map(([id, label]) => <a key={id} href={`#${id}`}>{t(label)}</a>)}
          </nav>
        </div>
      </section>

      <section id="stats" className="home-section home-wrap home-stats-section">
        {heading("home.statsTitle", "overview", "home.openProfile")}
        <div className="home-segments home-showcase-modes" role="group" aria-label={t("home.showcaseMode")}>
          {GAME_MODES.map((gameMode) => (
            <button key={gameMode} type="button" aria-pressed={gameMode === mode} onClick={() => setMode(gameMode)}>{t("fav.mode." + gameMode)}</button>
          ))}
        </div>
        {view || arena ? <div className={`home-profile-preview${switching ? " home-showcase-switching" : ""}`} aria-busy={switching || undefined}>
          <div className="home-profile-top">
            <div className="home-player-identity">
              <ProfilePortrait key={`${displayMode}:${displayAid}`} aid={displayAid} mode={displayMode} cycleId={displayMode === "seasonal" ? seasonalCycleId ?? undefined : undefined} nickname={name} />
              <div><div className="home-player-name-row"><Link prefetch={false} className="home-player-name" href={href}>{name}</Link><ProfilePrestige level={prestige} /></div><div className="home-player-mode"><span>{t("fav.mode." + displayMode)}</span>{side && <span className="home-player-side">{side}</span>}</div></div>
            </div>
            {view && <div className="home-level-value"><span>{t("metric.level")}</span><strong>{n(view.progression.level)}</strong></div>}
          </div>
          {arena ? <dl className="home-profile-metrics">
            <div><dt>{t("arena.metric.kd_ratio")}</dt><dd>{n(arenaMetricValue(arena.overall, "kd_ratio"), 2)}</dd></div>
            <div><dt>{t("arena.metric.win_rate")}</dt><dd>{n(arenaMetricValue(arena.overall, "win_rate"), 1)}{arenaMetricValue(arena.overall, "win_rate") != null && <span className="home-unit">%</span>}</dd></div>
            <div><dt>{t("arena.account.hours")}</dt><dd>{n(arena.overall.hours)}{arena.overall.hours != null && <span className="home-unit">{t("unit.h")}</span>}</dd></div>
            <div><dt>{t("arena.counter.matches")}</dt><dd>{n(arena.overall.counters.matches)}</dd></div>
          </dl> : view && <dl className="home-profile-metrics">
            <div><dt>{t("metric.pmc_kd_ratio")}</dt><dd>{n(view.overview.pmcKdRatio, 2)}</dd></div>
            <div><dt>{t("metric.pmc_survival_rate")}</dt><dd>{n(view.overview.pmcSurvivalRate, 1)}<span className="home-unit">%</span></dd></div>
            <div><dt>{t("metric.hours")}</dt><dd>{n(view.overview.lifetimePvpHours)}<span className="home-unit">{t("unit.h")}</span></dd></div>
            <div><dt>{t("metric.pmc_raids")}</dt><dd>{n(view.overview.pmcRaids)}</dd></div>
          </dl>}
          <div className="home-profile-bottom">
            {view && <><div className="home-achievement-count"><strong>{n(view.progression.achievementsCount)}</strong><span>{t("metric.achv_count")}</span></div>
            <div className="home-achievement-icons">{rarestAchievements(view.achievements.items.filter(achievementWithImage), ACHIEVEMENT_ICON_COUNT).map((item) => <Image key={item.id} src={item.imageUrl} width={42} height={42} alt={t("home.achievement", { name: (lang === "ru" ? item.nameRu : null) || item.name || item.id })} />)}</div>
            </>}
            <Link prefetch={false} className="home-text-link" href={`${href}#statistics`}>{t("home.allStats")}<span aria-hidden="true">→</span></Link>
          </div>
        </div> : <div className="home-loading-panel" role="status"><p>{t(unavailable ? "home.unavailable" : "common.loading")}</p>{unavailable && profileUrl != null && <button className="home-text-link" onClick={() => { forceUrl.current = profileUrl; setAttempt((value) => value + 1); }}>{t("leaderboard.retry")}</button>}</div>}
      </section>

      <section id="progress" className="home-section home-wrap">
        {heading("home.progressTitle", "progression", "home.openHistory")}
        <HomeProgress timeline={display?.timeline} name={name} />
      </section>

      <section id="risk" className="home-section home-risk-section">
        <div className="home-wrap">
          {heading("home.riskTitle", "risk", "home.openAnalysis")}
          <CheaterScore compact risk={display?.profile?.risk ?? null} loading={display == null}
            mode={displayMode} cycleId={display?.profile?.identity?.cycleId ?? "persistent"} statsKnown={riskScorable} />
          {name && <p className="home-risk-account">{name}<span>{t("fav.mode." + displayMode)}</span></p>}
          <p className="home-risk-note">{t("home.riskNote")}</p>
        </div>
      </section>

      <section id="compare" className="home-section home-wrap">
        {heading("home.compareTitle", "comparison", "home.openCompare")}
        <HomeComparison profile={display?.profile} cohort={display?.cohort} gameMode={displayMode} cycleId={display?.profile?.identity.cycleId ?? null} />
      </section>
      <HomeLeaderboard />
    </main>
  );
}
