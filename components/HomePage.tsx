"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import AuthErrorBanner from "@/components/AuthErrorBanner";
import CheaterScore from "@/components/CheaterScore";
import ProfilePortrait from "@/components/ProfilePortrait";
import SearchBar from "@/components/SearchBar";
import HomeComparison from "@/components/home/HomeComparison";
import HomeLeaderboard from "@/components/home/HomeLeaderboard";
import HomeProgress from "@/components/home/HomeProgress";
import { useI18n } from "@/lib/i18n/context";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import {
  HOME_EXAMPLE_AIDS,
  pickShowcaseAid,
  showcaseCohortParams,
  showcaseMode,
  showcaseProfileHref,
  showcaseTimelineCycle,
  type HomeCohort,
  type HomeProfile,
  type ShowcaseConfig,
} from "@/lib/home-showcase";
import { GAME_MODES, type GameMode, type ProgressionTimelineResponse } from "@/types/seasonal";
import "@/components/home/home.css";
import "@/components/profile.css";

interface ShowcaseSnapshot {
  mode: GameMode;
  profile: HomeProfile | null;
  timeline: ProgressionTimelineResponse | null;
  cohort: HomeCohort | null;
}

export default function HomePage() {
  const { t, lang } = useI18n();
  const [aid, setAid] = useState<number | null>(null);
  const [seasonalCycleId, setSeasonalCycleId] = useState<string | null>(null);
  const [mode, setMode] = useState<GameMode>("regular");
  const [snapshot, setSnapshot] = useState<ShowcaseSnapshot | null>(null);
  const [attempt, setAttempt] = useState(0);

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
    if (aid == null) return;
    let cancelled = false;
    const controller = new AbortController();
    const cycle = showcaseTimelineCycle(mode, seasonalCycleId);
    const cohort = showcaseCohortParams(mode);
    async function loadProfile(): Promise<HomeProfile | null> {
      const params = new URLSearchParams({ aid: String(aid), mode });
      if (mode === "seasonal" && cycle) params.set("cycle", cycle);
      try {
        const response = await loadPlayerProfileResponse<HomeProfile>(`/api/player/profile?${params}`);
        return response.ok && response.body.identity?.aid === aid && response.body.viewModel ? response.body : null;
      } catch { return null; }
    }
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
      cohort == null ? Promise.resolve(null)
        : load<HomeCohort>(`/api/average/cohort?aid=${aid}&mode=${mode}&cycle=${cohort.cycle}&statistic=trimmed_mean&period=all${cohort.arenaMode ? `&arenaMode=${cohort.arenaMode}` : ""}`),
    ]).then(([profile, timeline, cohortData]) => {
      if (!cancelled) setSnapshot({ mode, profile, timeline, cohort: cohortData });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [aid, mode, attempt, seasonalCycleId]);

  // Stale-while-revalidate: keep the previous mode's card on screen while the
  // next mode loads. Wiping to the loading panel collapses the section and
  // shifts the whole page on every switch. The stale snapshot keeps its own
  // mode for labels, values and links so data never mixes across modes.
  const current = snapshot && snapshot.mode === mode ? snapshot : null;
  const switching = current == null && snapshot != null;
  const display = current ?? snapshot;
  const displayMode: GameMode = display?.mode ?? mode;
  const view = display?.profile?.viewModel;
  const name = view?.identity.nickname ?? "";
  const displayAid = aid ?? HOME_EXAMPLE_AIDS[0];
  const href = showcaseProfileHref(displayMode, displayAid, seasonalCycleId);
  const unavailable = display != null && display.profile == null && !switching;
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
        {view ? <div className={`home-profile-preview${switching ? " home-showcase-switching" : ""}`} aria-busy={switching || undefined}>
          <div className="home-profile-top">
            <div className="home-player-identity">
              <ProfilePortrait key={`${displayMode}:${displayAid}`} aid={displayAid} mode={displayMode} cycleId={displayMode === "seasonal" ? seasonalCycleId ?? undefined : undefined} nickname={name} />
              <span className="home-faction" aria-hidden="true">{display?.profile?.stats?.side?.toUpperCase()}</span>
              <div><Link prefetch={false} className="home-player-name" href={href}>{name}</Link><div className="home-player-mode">{t("fav.mode." + displayMode)}</div></div>
            </div>
            <div className="home-level-value"><span>{t("metric.level")}</span><strong>{n(view.progression.level)}</strong></div>
          </div>
          <dl className="home-profile-metrics">
            <div><dt>{t("metric.pmc_kd_ratio")}</dt><dd>{n(view.overview.pmcKdRatio, 2)}</dd></div>
            <div><dt>{t("metric.pmc_survival_rate")}</dt><dd>{n(view.overview.pmcSurvivalRate, 1)}<span className="home-unit">%</span></dd></div>
            <div><dt>{t("metric.hours")}</dt><dd>{n(view.overview.lifetimePvpHours)}<span className="home-unit">{t("unit.h")}</span></dd></div>
            <div><dt>{t("metric.pmc_raids")}</dt><dd>{n(view.overview.pmcRaids)}</dd></div>
          </dl>
          <div className="home-profile-bottom">
            <div className="home-achievement-count"><strong>{n(view.progression.achievementsCount)}</strong><span>{t("metric.achv_count")}</span></div>
            <div className="home-achievement-icons">{view.achievements.items.filter((item) => item.imageUrl).slice(0, 5).map((item) => <Image key={item.id} src={item.imageUrl!} width={42} height={42} alt={t("home.achievement", { name: (lang === "ru" ? item.nameRu : null) || item.name || item.id })} />)}</div>
            <Link prefetch={false} className="home-text-link" href={`${href}#statistics`}>{t("home.allStats")}<span aria-hidden="true">→</span></Link>
          </div>
        </div> : <div className="home-loading-panel" role="status"><p>{t(unavailable ? "home.unavailable" : "common.loading")}</p>{unavailable && <button className="home-text-link" onClick={() => setAttempt((value) => value + 1)}>{t("leaderboard.retry")}</button>}</div>}
      </section>

      <section id="progress" className="home-section home-wrap">
        {heading("home.progressTitle", "progression", "home.openHistory")}
        <HomeProgress timeline={display?.timeline ?? undefined} name={name} />
      </section>

      <section id="risk" className="home-section home-risk-section">
        <div className="home-wrap">
          {heading("home.riskTitle", "risk", "home.openAnalysis")}
          <CheaterScore compact risk={display?.profile?.risk ?? null} loading={display == null} />
          {name && <p className="home-risk-account">{name}<span>{t("fav.mode." + displayMode)}</span></p>}
          <p className="home-risk-note">{t("home.riskNote")}</p>
        </div>
      </section>

      <section id="compare" className="home-section home-wrap">
        {heading("home.compareTitle", "comparison", "home.openCompare")}
        <HomeComparison profile={display?.profile ?? undefined} cohort={display?.cohort ?? undefined} />
      </section>
      <HomeLeaderboard />
    </main>
  );
}
