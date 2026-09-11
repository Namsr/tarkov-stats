"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ArenaOverallComparison from "@/components/ArenaOverallComparison";
import ArenaRiskPanel from "@/components/ArenaRiskPanel";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import ProfileHeader from "@/components/ProfileHeader";
import ProfileSectionNav from "@/components/ProfileSectionNav";
import StatCard from "@/components/StatCard";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import { useFavorites } from "@/lib/favorites/context";
import { isProfileStale } from "@/lib/profile-refresh-policy";
import {
  ARENA_MODE_KEYS,
  toArenaProfile,
  formatArenaValue,
  formatArenaMetric,
} from "@/components/arena-ui";
import { loadPlayerProfileResponse, getCachedPlayerProfileResponse, PlayerProfileResponseError } from "@/lib/client-profile-request";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaProfile, ArenaProfileRisk, ArenaStatistic } from "@/types/arena";
import ProfilePrimaryActions, { ProfileActivity } from "@/components/ProfileActions";
import ArenaModeBars from "@/components/ArenaModeBars";
import type { ArenaCounters, ArenaStoredMode } from "@/types/arena";
import "@/components/profile.css";
import { upsertRecentPlayer } from "@/lib/recent-players";
import { isReload } from "@/lib/is-reload";

interface Props {
  aid: string;
  radarDemo?: string | string[];
}

interface ArenaResponse {
  arena?: ArenaProfile;
  stats?: unknown;
  arenaStatus?: string;
  profile?: unknown;
  risk?: ArenaProfileRisk | null;
  arenaRisk?: ArenaProfileRisk | null;
  profileUpdatedAt?: number | null;
  freshness?: { fetchedAt?: number | null; updatedAt?: number | null };
  capture?: { inserted?: boolean; status?: string };
  code?: string;
  error?: string;
  identity?: { aid?: number; mode?: string; cycleId?: string };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function responseRisk(value: unknown): ArenaProfileRisk | null {
  const data = record(value);
  const risk = data.risk ?? data.arenaRisk;
  return risk && typeof risk === "object" ? risk as ArenaProfileRisk : null;
}

function isLegacyArenaResponse(value: unknown): boolean {
  return record(value).arenaStatus === "legacy_incomplete";
}

function legacyNumber(value: unknown, key: string): number | null {
  const body = record(value);
  const stats = record(body.stats);
  const arena = record(stats.arena);
  const source = key === "hoursPlayed" ? stats : arena;
  const raw = source[key];
  const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(number) ? number : null;
}

function legacyNickname(value: unknown): string {
  const body = record(value);
  const stats = record(body.stats);
  const profile = record(body.profile);
  const info = record(profile.info);
  return String(stats.nickname ?? info.nickname ?? "").trim();
}

function statisticFromUrl(): ArenaStatistic {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("arenaStatistic") === "median") return "median";
  return "trimmed_mean";
}

function arenaModeFromUrl(): ArenaStoredMode | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("arenaMode");
  return value === "overall" ? "overall" : ARENA_MODE_KEYS.find((mode) => mode === value) ?? null;
}

function ArenaProfileActions({
  aid,
  nickname,
  stale,
  onCheck,
}: {
  aid: number;
  nickname: string;
  stale: boolean;
  onCheck: () => Promise<RefreshCheckResult>;
}) {
  const { t } = useI18n();
  return (
    <div className="profile-actions-grid">
      <div className="profile-action-stack">
        <RefreshButton aid={aid} mode="arena" stale={stale} onCheck={onCheck} className="whitespace-nowrap" />
        {stale && <p className="max-w-56 text-xs font-medium leading-snug text-[var(--danger)]">{t("player.refreshStaleMessage")}</p>}
      </div>
      <FavoriteButton aid={aid} nickname={nickname} identity={{ mode: "arena", cycleId: "persistent" }} />
      <CheaterReportButton aid={aid} mode="arena" cycle="persistent" />
    </div>
  );
}

export function ArenaProfileLoading() {
  const { t } = useI18n();
  return (
    <main className="page-frame profile-page" aria-label={t("arena.profile.loading")}>
      <div className="surface p-5 sm:p-6">
        <div className="h-3 w-16 skeleton rounded" />
        <div className="mt-4 h-12 w-56 skeleton rounded" />
        <div className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-24 skeleton rounded-xl" />)}
        </div>
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div className="h-[420px] skeleton rounded-xl" />
        <div className="h-[420px] skeleton rounded-xl" />
      </div>
    </main>
  );
}

function ArenaLegacyIncomplete({
  aid,
  body,
  onCheck,
}: {
  aid: number;
  body: ArenaResponse;
  onCheck: () => Promise<RefreshCheckResult>;
}) {
  const { t } = useI18n();
  const nickname = legacyNickname(body) || t("arena.account.unknown");
  const legacyProfile = toArenaProfile(body.stats, aid);
  const updatedAt = Number(body.profileUpdatedAt);
  const stale = isProfileStale(Number.isFinite(updatedAt) ? updatedAt : null);
  const numberValue = (key: string, decimals = 0) => {
    const value = legacyNumber(body, key);
    return value == null || (key === "kdRatio" && value <= 0)
      ? t("common.notAvailable")
      : value.toLocaleString(undefined, { maximumFractionDigits: decimals });
  };
  return (
    <main className="page-frame profile-page">
      <Link href="/" className="mb-8 inline-block text-sm text-[var(--muted)] hover:text-[var(--foreground)]">{t("common.back")}</Link>
      <ProfileHeader
        aid={aid}
        mode="arena"
        kicker={`#${aid}`}
        title={nickname}
        meta={<p className="text-sm text-[var(--muted)]">{t("arena.profile.legacyTitle")}</p>}
        actions={<ArenaProfileActions aid={aid} nickname={nickname} stale={stale} onCheck={onCheck} />}
      >
        <div className="px-[18px] pb-5 sm:px-6 sm:pb-6">
          <p className="mb-4 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t("arena.profile.legacyDescription")}</p>
          <div className="detail-grid detail-grid--compact">
            <StatCard label={t("arena.account.hours")} value={numberValue("hoursPlayed")} suffix={legacyNumber(body, "hoursPlayed") == null ? undefined : t("unit.h")} />
            <StatCard label={t("arena.counter.kills")} value={numberValue("totalKills")} />
            <StatCard label={t("arena.counter.deaths")} value={numberValue("totalDeaths")} />
            <StatCard label={t("arena.metric.kd_ratio")} value={numberValue("kdRatio", 2)} />
            <StatCard label={t("arena.counter.currentKillStreak")} value={numberValue("currentKillStreak")} />
            <StatCard label={t("arena.counter.maxKillStreak")} value={numberValue("maxKillStreak")} />
          </div>
        </div>
      </ProfileHeader>
      <section className="mt-5 space-y-5" aria-label={t("arena.section.modes")}>
        {ARENA_MODE_KEYS.map((mode) => {
          const stats = legacyProfile?.modes[mode] ?? null;
          const fields: Array<[string, string]> = [];
          if (stats?.counters.kills != null) fields.push([t("arena.counter.kills"), formatArenaValue(stats.counters.kills)]);
          if (stats?.counters.deaths != null) fields.push([t("arena.counter.deaths"), formatArenaValue(stats.counters.deaths)]);
          if (stats?.metrics.kd_ratio != null && stats.metrics.kd_ratio > 0) fields.push([t("arena.metric.kd_ratio"), formatArenaMetric(stats.metrics.kd_ratio, "kd_ratio")]);
          if (stats?.counters.max_kill_streak != null) fields.push([t("arena.counter.maxKillStreak"), formatArenaValue(stats.counters.max_kill_streak)]);
          if (stats?.counters.round_mvp != null) fields.push([t("arena.counter.roundMvp"), formatArenaValue(stats.counters.round_mvp)]);
          if (stats?.counters.match_mvp != null) fields.push([t("arena.counter.matchMvp"), formatArenaValue(stats.counters.match_mvp)]);
          if (stats?.counters.max_win_streak != null) fields.push([t("arena.counter.maxWinStreak"), formatArenaValue(stats.counters.max_win_streak)]);
          return (
            <article key={mode} className="data-panel p-5 sm:p-6">
              <p className="section-kicker">{t("arena.modeKicker")}</p>
              <h2 className="section-heading mt-1">{t("arena.mode." + mode)}</h2>
              {fields.length > 0 ? (
                <div className="mt-5 detail-grid detail-grid--compact">
                  {fields.map(([label, value]) => <StatCard key={label} label={label} value={value} />)}
                </div>
              ) : (
                <p className="mt-4 rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] p-3 text-sm text-[var(--muted)]">{t("arena.profile.legacyModeIncomplete")}</p>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}

export default function ArenaPlayer({ aid }: Props) {
  const { lang, t } = useI18n();
  const numericAid = Number(aid);
  const profileRequestUrl = `/api/player/profile?${new URLSearchParams({ aid, mode: "arena" })}`;
  const initialBody = useMemo(
    () => getCachedPlayerProfileResponse<ArenaResponse>(profileRequestUrl)?.body,
    [profileRequestUrl],
  );
  const initialProfile = useMemo(
    () => isLegacyArenaResponse(initialBody) ? null : toArenaProfile(initialBody, numericAid),
    [initialBody, numericAid],
  );
  const [legacyBody, setLegacyBody] = useState<ArenaResponse | null>(isLegacyArenaResponse(initialBody) ? initialBody ?? null : null);
  const [profile, setProfile] = useState<ArenaProfile | null>(initialProfile);
  const [risk, setRisk] = useState<ArenaProfileRisk | null>(responseRisk(initialBody));
  const [loading, setLoading] = useState(initialProfile === null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [statistic, setStatistic] = useState<ArenaStatistic>("trimmed_mean");
  const [selectedMode, setSelectedMode] = useState<ArenaStoredMode>("overall");
  const refreshPromise = useRef<Promise<RefreshCheckResult> | null>(null);
  const { authStatus, favorites } = useFavorites();

  useEffect(() => {
    const onPopState = () => {
      setStatistic(statisticFromUrl());
      const mode = arenaModeFromUrl();
      setSelectedMode(mode ?? "overall");
    };
    onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const force = isReload();
    const params = new URLSearchParams({ aid, mode: "arena" });
    if (force) params.set("refresh", "1");
    setLoading(!initialProfile);
    setError("");
    setUnavailable(false);
    loadPlayerProfileResponse<ArenaResponse>(`/api/player/profile?${params}`, { force })
      .then(({ ok, body }) => {
        if (!ok) {
          if (body.code === "mode_profile_unavailable") {
            if (!cancelled) setUnavailable(true);
            return null;
          }
          throw new Error(body.error ?? t("arena.profile.error"));
        }
        if (isLegacyArenaResponse(body)) return { body, profile: null, legacy: true };
        const nextProfile = toArenaProfile(body, numericAid);
        if (!nextProfile) throw new Error(t("arena.profile.error"));
        return { body, profile: nextProfile, legacy: false };
      })
      .then((result) => {
        if (cancelled || !result) return;
        if (result.legacy) {
          setLegacyBody(result.body);
          setProfile(null);
          setRisk(null);
          setUnavailable(false);
          return;
        }
        setLegacyBody(null);
        const nextProfile = result.profile;
        if (!nextProfile) return;
        setProfile(nextProfile);
        setRisk(responseRisk(result.body));
        if (nextProfile.nickname) upsertRecentPlayer({ aid, nickname: nextProfile.nickname, mode: "arena" });
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof PlayerProfileResponseError ? t("arena.profile.error") : caught instanceof Error ? caught.message : t("arena.profile.error"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aid, initialProfile, numericAid, t]);

  const refreshProfile = useCallback(() => {
    if (refreshPromise.current) return refreshPromise.current;
    const previous = profile;
    const params = new URLSearchParams({ aid, mode: "arena", refresh: "1" });
    const request = loadPlayerProfileResponse<ArenaResponse>(`/api/player/profile?${params}`, { force: true })
      .then(({ ok, body }): RefreshCheckResult => {
        if (!ok) {
          if (body.code === "mode_profile_unavailable") {
            setUnavailable(true);
            return "unchanged";
          }
          throw new Error(body.error ?? t("arena.profile.error"));
        }
        if (body.capture?.status === "refresh_failed") {
          throw new Error(t("player.refreshStatus.error"));
        }
        if (isLegacyArenaResponse(body)) {
          setLegacyBody(body);
          setProfile(null);
          setRisk(null);
          setUnavailable(false);
          return "unchanged";
        }
        const nextProfile = toArenaProfile(body, numericAid);
        if (!nextProfile) throw new Error(t("arena.profile.error"));
        setProfile(nextProfile);
        setRisk(responseRisk(body));
        setUnavailable(false);
        setError("");
        if (nextProfile.nickname) upsertRecentPlayer({ aid, nickname: nextProfile.nickname, mode: "arena" });
        return previous?.profileUpdatedAt !== nextProfile.profileUpdatedAt ? "updated" : "unchanged";
      })
      .catch((caught: unknown) => {
        throw caught instanceof PlayerProfileResponseError ? new Error(t("arena.profile.error")) : caught;
      })
      .finally(() => {
        if (refreshPromise.current === request) refreshPromise.current = null;
      });
    refreshPromise.current = request;
    return request;
  }, [aid, numericAid, profile, t]);

  const eligibleFavorites = useMemo(
    () => favorites.filter((favorite) => favorite.aid !== numericAid),
    [favorites, numericAid],
  );
  const [selectedFavoriteAid, setSelectedFavoriteAid] = useState<number | null>(null);
  const [showFavorite, setShowFavorite] = useState(false);
  const defaultFavoriteAid = eligibleFavorites.find((favorite) => favorite.isMain)?.aid ?? eligibleFavorites[0]?.aid ?? null;
  const effectiveFavoriteAid = eligibleFavorites.some((favorite) => favorite.aid === selectedFavoriteAid) ? selectedFavoriteAid : defaultFavoriteAid;
  const selectedFavorite = eligibleFavorites.find((favorite) => favorite.aid === effectiveFavoriteAid) ?? null;
  const [favoriteProfile, setFavoriteProfile] = useState<ArenaProfile | null>(null);
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const [favoriteError, setFavoriteError] = useState(false);

  useEffect(() => {
    if (!showFavorite || authStatus !== "authenticated" || effectiveFavoriteAid == null) {
      setFavoriteProfile(null);
      setFavoriteError(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const params = new URLSearchParams({ aid: String(effectiveFavoriteAid), mode: "arena" });
    setFavoriteLoading(true);
    setFavoriteError(false);
    fetch(`/api/player/profile?${params}`, { signal: controller.signal, cache: "default" })
      .then(async (response) => {
        const body = await response.json() as ArenaResponse;
        if (!response.ok) throw new Error();
        return isLegacyArenaResponse(body) ? null : toArenaProfile(body, effectiveFavoriteAid);
      })
      .then((next) => {
        if (active) setFavoriteProfile(next);
      })
      .catch(() => {
        if (active) {
          setFavoriteProfile(null);
          setFavoriteError(true);
        }
      })
      .finally(() => {
        if (active) setFavoriteLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [authStatus, effectiveFavoriteAid, showFavorite]);

  if (loading && !profile && !legacyBody) return <ArenaProfileLoading />;
  if (legacyBody) return <ArenaLegacyIncomplete aid={numericAid} body={legacyBody} onCheck={refreshProfile} />;
  if (unavailable || !profile) {
    return (
      <main className="page-frame profile-page">
        <Link href="/" className="mb-8 inline-block text-sm text-[var(--muted)] hover:text-[var(--foreground)]">{t("common.back")}</Link>
        <section className="data-panel p-6 text-center" role="status">
          <p className="text-[var(--danger)]">{t("arena.profile.unavailable")}</p>
          <RefreshButton aid={numericAid} mode="arena" missing onCheck={refreshProfile} />
        </section>
      </main>
    );
  }

  const scopeStats = selectedMode === "overall" ? profile.overall : profile.modes[selectedMode];
  const scopeName = t(selectedMode === "overall" ? "profile.allModes" : "arena.mode." + selectedMode);
  const favoriteName = selectedFavorite?.nickname ?? favoriteProfile?.nickname ?? null;
  const canCompareFavorite = authStatus === "authenticated" && eligibleFavorites.length > 0;
  const comparedFavorite = showFavorite && canCompareFavorite ? favoriteProfile : null;
  const favoriteStats = selectedMode === "overall" ? comparedFavorite?.overall : comparedFavorite?.modes[selectedMode];
  const number = (value: number | null, digits = 0) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(lang, { maximumFractionDigits: digits });
  const changeMode = (mode: ArenaStoredMode) => {
    setSelectedMode(mode);
    const params = new URLSearchParams(window.location.search);
    if (mode === "overall") params.delete("arenaMode");
    else params.set("arenaMode", mode);
    window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`);
  };
  const groups: Array<{ title: string; rows: Array<[keyof ArenaCounters, string]> }> = [
    { title: "profile.arenaCombat", rows: [["kills", "arena.counter.kills"], ["deaths", "arena.counter.deaths"], ["assists", "arena.counter.assists"], ["headshots", "arena.counter.headshots"], ["damage", "arena.counter.damage"], ["max_kill_streak", "arena.counter.maxKillStreak"]] },
    { title: "profile.arenaResults", rows: [["wins", "arena.counter.wins"], ["losses", "arena.counter.losses"], ["round_mvp", "arena.counter.roundMvp"], ["match_mvp", "arena.counter.matchMvp"], ["max_win_streak", "arena.counter.maxWinStreak"], ["max_loss_streak", "arena.counter.maxLossStreak"]] },
  ];
  return <main className="page-frame profile-page" data-profile-shell-mode="arena">
    <Link href="/" className="profile-back">{t("common.back")}</Link>
    <ProfileHeader aid={numericAid} mode="arena" kicker={`#${aid}`} title={profile.nickname || t("arena.account.unknown")}
      leaderboardArenaMode={selectedMode === "overall" ? "blastGang" : selectedMode}
      leaderboardRevision={`${profile.profileUpdatedAt}:${profile.fetchedAt ?? "unknown"}:${profile.parserVersion}`}
      meta={<div className="profile-header__meta"><span>{t("fav.mode.arena")}</span>{profile.overall.bestArp != null && <span>{t("arena.bestArp")}: {number(profile.overall.bestArp)}</span>}</div>}
      actions={<ProfilePrimaryActions aid={numericAid} mode="arena" cycleId="persistent" nickname={profile.nickname} />}
      activity={<ProfileActivity aid={numericAid} mode="arena" updatedAt={profile.profileUpdatedAt} onCheck={refreshProfile} />}>
      <ProfileSectionNav label={t("profile.sectionNav")} items={[{ id: "arena-modes", label: t("arena.byMode") }, { id: "arena-risk", label: t("profile.section.risk") }, { id: "arena-comparison", label: t("profile.section.comparison") }, { id: "statistics", label: t("profile.section.statistics") }]} />
      <div className="profile-arena-scopes" role="group" aria-label={t("arena.modePicker.label")}>{(["overall", ...ARENA_MODE_KEYS] as const).map((mode) => <button key={mode} type="button" aria-pressed={selectedMode === mode} onClick={() => changeMode(mode)}>{t(mode === "overall" ? "profile.allModes" : "arena.mode." + mode)}</button>)}</div>
      <div className="profile-metrics">{[
        { label: t("arena.metric.kd_ratio"), value: number(scopeStats.metrics.kd_ratio, 2) },
        { label: t("arena.metric.win_rate"), value: number(scopeStats.metrics.win_rate, 1), suffix: scopeStats.metrics.win_rate == null ? "" : "%" },
        { label: t("arena.counter.matches"), value: number(scopeStats.counters.matches) },
        { label: t("metric.hours"), value: number(profile.overall.hours) },
      ].map((item) => <dl key={item.label} className="profile-metric"><dt>{item.label}</dt><dd>{item.value}{item.suffix && <span>{item.suffix}</span>}</dd></dl>)}</div>
    </ProfileHeader>
    <div className="profile-content">
      <ArenaModeBars profile={profile} selected={selectedMode} onSelect={changeMode} />
      <div className="profile-analysis">
        <section id="arena-risk" tabIndex={-1} className="profile-anchor-section"><ArenaRiskPanel compact risk={risk} scope={selectedMode} /></section>
        <section id="arena-comparison" tabIndex={-1} className="profile-anchor-section profile-comparison">
          <h2 className="section-heading">{t("profile.section.comparison")}</h2>
          <div className="profile-comparison-controls">
            <div className="profile-segments" role="group" aria-label={t("home.compareWith")}><button type="button" aria-pressed={!showFavorite || !canCompareFavorite} onClick={() => setShowFavorite(false)}>{t("home.averagePlayer")}</button>
              <span className={canCompareFavorite ? undefined : "disabled-control-hint"} tabIndex={canCompareFavorite ? undefined : 0} role={canCompareFavorite ? undefined : "group"} aria-label={canCompareFavorite ? undefined : t("home.anotherPlayer")} aria-describedby={canCompareFavorite ? undefined : "arena-favorite-hint"}>
                <button type="button" aria-pressed={showFavorite && canCompareFavorite} disabled={!canCompareFavorite} aria-describedby={canCompareFavorite ? undefined : "arena-favorite-hint"} onClick={() => setShowFavorite(true)}>{t("home.anotherPlayer")}</button>
                {!canCompareFavorite && <span id="arena-favorite-hint" role="tooltip" className="disabled-control-tooltip">{t(authStatus === "authenticated" ? "arena.favorite.empty" : "arena.favorite.authRequired")}</span>}
              </span>
            </div>
            {showFavorite && canCompareFavorite && <label className="profile-select"><span className="sr-only">{t("arena.favorite.label")}</span><select value={effectiveFavoriteAid ?? ""} onChange={(event) => setSelectedFavoriteAid(Number(event.target.value))}>{eligibleFavorites.map((favorite) => <option key={favorite.aid} value={favorite.aid}>{favorite.nickname || `#${favorite.aid}`}</option>)}</select></label>}
          </div>
          <div className="profile-comparison-method"><label className="profile-select"><span className="sr-only">{t("arena.statistic.label")}</span><select value={statistic} onChange={(event) => {
            const next = event.target.value === "median" ? "median" : "trimmed_mean";
            setStatistic(next);
            const params = new URLSearchParams(window.location.search);
            if (next === "median") params.set("arenaStatistic", next); else params.delete("arenaStatistic");
            window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`);
          }}><option value="trimmed_mean">{t("arena.statistic.trimmedMean")}</option><option value="median">{t("arena.statistic.median")}</option></select></label><span className="profile-scope-name">{scopeName}</span></div>
          {showFavorite && (favoriteLoading || favoriteError) && <p className="profile-chart-notice" role="status">{t(favoriteError ? "arena.favorite.error" : "arena.favorite.loading")}</p>}
          <ArenaOverallComparison key={`${numericAid}:${selectedMode}:${statistic}`} aid={numericAid} mode={selectedMode} player={scopeStats} playerName={profile.nickname} statistic={statistic} favorite={favoriteStats} favoriteName={favoriteName} compareFavorite={showFavorite && canCompareFavorite} />
        </section>
      </div>
      <section id="statistics" tabIndex={-1} className="profile-anchor-section"><div className="profile-collection__heading"><h2 className="section-heading">{t("profile.section.statistics")}</h2><span className="profile-scope-name">{scopeName}</span></div><div className="profile-statistics">{groups.map((group) => <div key={group.title}><h3>{t(group.title)}</h3><div className="data-ledger">{group.rows.map(([key, label]) => <StatCard key={key} label={t(label)} value={number(scopeStats.counters[key])} />)}</div></div>)}</div></section>
    </div>
    {error && <p className="profile-chart-notice" role="status">{error}</p>}
  </main>;
}
