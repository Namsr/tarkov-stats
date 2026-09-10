"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import AuthErrorBanner from "@/components/AuthErrorBanner";
import SearchBar from "@/components/SearchBar";
import CheaterScore from "@/components/CheaterScore";
import HomeProgress from "@/components/home/HomeProgress";
import HomeComparison from "@/components/home/HomeComparison";
import HomeLeaderboard from "@/components/home/HomeLeaderboard";
import { useI18n } from "@/lib/i18n/context";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import { HOME_EXAMPLE_AIDS, HOME_COMPARISON_AID, type HomeProfile, type HomeCohort } from "@/lib/home-showcase";
import type { ProgressionTimelineResponse } from "@/types/seasonal";
import "@/components/home/home.css";

export default function HomePage() {
  const { t, lang } = useI18n();
  const [aid, setAid] = useState<number | null>(null);
  const [profile, setProfile] = useState<HomeProfile | null>();
  const [other, setOther] = useState<HomeProfile | null>();
  const [timeline, setTimeline] = useState<ProgressionTimelineResponse | null>();
  const [cohort, setCohort] = useState<HomeCohort | null>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setAid(HOME_EXAMPLE_AIDS[Math.floor(Math.random() * HOME_EXAMPLE_AIDS.length)]);
  }, []);

  useEffect(() => {
    if (aid == null) return;
    let cancelled = false;
    const controller = new AbortController();
    setProfile(undefined); setOther(undefined); setTimeline(undefined); setCohort(undefined);
    async function loadProfile(id: number, update: typeof setProfile) {
      try {
        const response = await loadPlayerProfileResponse<HomeProfile>(`/api/player/profile?aid=${id}&mode=regular`);
        if (!cancelled) update(response.ok && response.body.identity?.aid === id && response.body.viewModel ? response.body : null);
      } catch { if (!cancelled) update(null); }
    }
    async function load<T>(url: string, update: (value: T | null) => void) {
      try {
        const response = await fetch(url, { signal: controller.signal });
        const value = response.ok ? await response.json() as T : null;
        if (!cancelled) update(value);
      } catch { if (!cancelled) update(null); }
    }
    void loadProfile(aid, setProfile);
    void loadProfile(HOME_COMPARISON_AID, setOther);
    void load<ProgressionTimelineResponse>(`/api/progression/timeline?aid=${aid}&mode=regular&cycle=persistent`, setTimeline);
    void load<HomeCohort>(`/api/average/cohort?aid=${aid}&mode=regular&cycle=persistent&statistic=trimmed_mean&period=all`, setCohort);
    return () => { cancelled = true; controller.abort(); };
  }, [aid, attempt]);

  const view = profile?.viewModel;
  const name = view?.identity.nickname ?? "";
  const href = `/player/regular/${aid ?? HOME_EXAMPLE_AIDS[0]}`;
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
        {view ? <div className="home-profile-preview">
          <div className="home-profile-top">
            <div className="home-player-identity"><span className="home-faction" aria-hidden="true">{profile?.stats?.side?.toUpperCase()}</span><div><Link prefetch={false} className="home-player-name" href={href}>{name}</Link><div className="home-player-mode">{t("fav.mode.regular")}</div></div></div>
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
        </div> : <div className="home-loading-panel" role="status"><p>{t(profile === undefined ? "common.loading" : "home.unavailable")}</p>{profile === null && <button className="home-text-link" onClick={() => setAttempt((value) => value + 1)}>{t("leaderboard.retry")}</button>}</div>}
      </section>

      <section id="progress" className="home-section home-wrap">
        {heading("home.progressTitle", "progression", "home.openHistory")}
        <HomeProgress timeline={timeline} name={name} />
      </section>

      <section id="risk" className="home-section home-risk-section">
        <div className="home-wrap">
          {heading("home.riskTitle", "risk", "home.openAnalysis")}
          <CheaterScore compact risk={profile?.risk} loading={profile === undefined} />
          {name && <p className="home-risk-account">{name}<span>{t("fav.mode.regular")}</span></p>}
          <p className="home-risk-note">{t("home.riskNote")}</p>
        </div>
      </section>

      <section id="compare" className="home-section home-wrap">
        {heading("home.compareTitle", "comparison", "home.openCompare")}
        <HomeComparison profile={profile} other={other} cohort={cohort} />
      </section>
      <HomeLeaderboard />
    </main>
  );
}
