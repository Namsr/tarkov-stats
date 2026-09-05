"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ArenaAccountCard from "@/components/ArenaAccountCard";
import ArenaModeComparison from "@/components/ArenaModeComparison";
import ArenaOverallComparison from "@/components/ArenaOverallComparison";
import ArenaRiskPanel from "@/components/ArenaRiskPanel";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import CompactDetails from "@/components/CompactDetails";
import ProfileHeader from "@/components/ProfileHeader";
import ProfileSectionNav from "@/components/ProfileSectionNav";
import StatCard from "@/components/StatCard";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import { useFavorites } from "@/lib/favorites/context";
import { isProfileStale } from "@/lib/profile-refresh-policy";
import {
  ARENA_METRIC_KEYS,
  ARENA_MODE_KEYS,
  toArenaProfile,
  formatArenaValue,
  formatArenaMetric,
  type ArenaModeKey,
} from "@/components/arena-ui";
import { loadPlayerProfileResponse, getCachedPlayerProfileResponse, PlayerProfileResponseError } from "@/lib/client-profile-request";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaProfile, ArenaProfileRisk, ArenaStatistic } from "@/types/arena";
import type { Favorite } from "@/lib/db";
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

function responseFreshness(value: unknown): number | null {
  const data = record(value);
  const freshness = record(data.freshness);
  const valueAt = freshness.fetchedAt ?? freshness.updatedAt;
  const number = Number(valueAt);
  return Number.isFinite(number) && number > 0 ? number : null;
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

function formatDate(timestamp: number | null, lang: "en" | "ru"): string | null {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function statisticFromUrl(): ArenaStatistic {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("arenaStatistic") === "median") return "median";
  return "trimmed_mean";
}

function arenaModeFromUrl(): ArenaModeKey | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("arenaMode");
  return ARENA_MODE_KEYS.find((mode) => mode === value) ?? null;
}

function mostPlayedMode(profile: ArenaProfile | null): ArenaModeKey {
  if (!profile) return ARENA_MODE_KEYS[0];
  return ARENA_MODE_KEYS.reduce((best, mode) => {
    const bestMatches = profile.modes[best].counters.matches ?? -1;
    const matches = profile.modes[mode].counters.matches ?? -1;
    return matches > bestMatches ? mode : best;
  }, ARENA_MODE_KEYS[0]);
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
    <main className="page-frame" aria-label={t("arena.profile.loading")}>
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
    <main className="page-frame">
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

function ArenaModeSection({
  aid,
  mode,
  profile,
  statistic,
  risk,
  favorite,
  favoriteName,
}: {
  aid: number;
  mode: ArenaModeKey;
  profile: ArenaProfile;
  statistic: ArenaStatistic;
  risk: ArenaProfileRisk | null;
  favorite?: ArenaProfile | null;
  favoriteName?: string | null;
}) {
  const { t } = useI18n();
  const stats = profile.modes[mode];
  const hasModeData = stats.hours !== null || Object.values(stats.counters).some((value) => value !== null) || Object.values(stats.metrics).some((value) => value !== null);
  return (
    <article id={`arena-mode-${mode}`} className="surface scroll-mt-24 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-kicker">{t("arena.modeKicker")}</p>
          <h2 className="section-heading mt-1">{t("arena.mode." + mode)}</h2>
        </div>
        {stats.hours != null && <p className="text-xs tabular-nums text-[var(--muted)]">{t("arena.modeHours", { hours: Math.round(stats.hours) })}</p>}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {ARENA_METRIC_KEYS.map((metric) => {
          const value = stats.metrics[metric];
          return (
            <div key={metric} className="metric-card">
              <span className="metric-card__label">{t("arena.metric." + metric)}</span>
              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span className="metric-card__value">{formatArenaMetric(value, metric)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {!hasModeData && <p className="mt-4 rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] p-3 text-sm text-[var(--muted)]">{t("arena.modeNoData")}</p>}
      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,.8fr)] xl:items-start">
        <ArenaModeComparison
          aid={aid}
          mode={mode}
          player={stats}
          statistic={statistic}
          favorite={favorite?.modes[mode] ?? null}
          favoriteName={favoriteName}
        />
        <ArenaRiskPanel risk={risk} scope={mode} />
      </div>
    </article>
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
  const [freshnessAt, setFreshnessAt] = useState<number | null>(responseFreshness(initialBody));
  const [loading, setLoading] = useState(initialProfile === null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [stale, setStale] = useState(isProfileStale(initialProfile?.profileUpdatedAt ?? null));
  const [statistic, setStatistic] = useState<ArenaStatistic>("trimmed_mean");
  const [selectedMode, setSelectedMode] = useState<ArenaModeKey>(() => mostPlayedMode(initialProfile));
  const refreshPromise = useRef<Promise<RefreshCheckResult> | null>(null);
  const { authStatus, favorites } = useFavorites();

  useEffect(() => {
    const onPopState = () => {
      setStatistic(statisticFromUrl());
      const mode = arenaModeFromUrl();
      if (mode) setSelectedMode(mode);
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
        setFreshnessAt(responseFreshness(result.body));
        setStale(isProfileStale(nextProfile.profileUpdatedAt));
        if (!arenaModeFromUrl()) setSelectedMode(mostPlayedMode(nextProfile));
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
        setFreshnessAt(responseFreshness(body));
        setStale(isProfileStale(nextProfile.profileUpdatedAt));
        if (!arenaModeFromUrl()) setSelectedMode(mostPlayedMode(nextProfile));
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
      <main className="page-frame">
        <Link href="/" className="mb-8 inline-block text-sm text-[var(--muted)] hover:text-[var(--foreground)]">{t("common.back")}</Link>
        <section className="data-panel p-6 text-center" role="status">
          <p className="text-[var(--danger)]">{t("arena.profile.unavailable")}</p>
          <RefreshButton aid={numericAid} mode="arena" missing onCheck={refreshProfile} />
        </section>
      </main>
    );
  }

  const updatedDate = formatDate(profile.profileUpdatedAt, lang);
  const fetchedDate = formatDate(freshnessAt, lang);
  const sectionLinks = [
    { id: "overview", label: t("profile.section.overview") },
    { id: "arena-risk", label: t("profile.section.risk") },
    { id: "arena-comparison", label: t("profile.section.comparison") },
    { id: "arena-modes", label: t("arena.section.modes") },
  ];
  const favoriteName = selectedFavorite?.nickname ?? favoriteProfile?.nickname ?? null;
  const comparedFavorite = showFavorite ? favoriteProfile : null;
  const canCompareFavorite = authStatus === "authenticated" && eligibleFavorites.length > 0;

  const changeMode = (mode: ArenaModeKey) => {
    setSelectedMode(mode);
    const params = new URLSearchParams(window.location.search);
    params.set("arenaMode", mode);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
  };

  return (
    <main className="page-frame">
      <Link href="/" className="mb-8 inline-block text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]">{t("common.back")}</Link>
      <ProfileSectionNav label={t("profile.sectionNav")} items={sectionLinks} />
      <ProfileHeader
        aid={numericAid}
        mode="arena"
        kicker={t("arena.profile.kicker", { aid: numericAid })}
        title={profile.nickname || t("arena.account.unknown")}
        leaderboardArenaMode={selectedMode}
        leaderboardRevision={`${profile.profileUpdatedAt}:${profile.fetchedAt ?? "unknown"}:${profile.parserVersion}`}
        meta={
          <div>
            {updatedDate && (
              <div className="profile-header__meta">
                <span>{t("arena.profile.updated", { date: updatedDate })}</span>
              </div>
            )}
            <CompactDetails summary={t("arena.profile.dataDetails")} className="mt-2">
              <div className="grid gap-1">
                {fetchedDate && <span>{t("arena.profile.fetched", { date: fetchedDate })}</span>}
                <span>{t("arena.profile.parser", { n: profile.parserVersion })}</span>
              </div>
            </CompactDetails>
          </div>
        }
        actions={<ArenaProfileActions aid={numericAid} nickname={profile.nickname} stale={stale} onCheck={refreshProfile} />}
      >
        <div className="mt-1 px-[18px] pb-5 sm:px-6 sm:pb-6">
          <ArenaAccountCard profile={profile} />
        </div>
      </ProfileHeader>

      <section className="mt-5 data-panel p-4 sm:p-5" aria-label={t("arena.compare.controls") }>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="native-select min-w-[220px]">
              <span>{t("arena.statistic.label")}</span>
              <select
                value={statistic}
                onChange={(event) => {
                  const next = event.target.value === "median" ? "median" : "trimmed_mean";
                  setStatistic(next);
                  const params = new URLSearchParams(window.location.search);
                  if (next === "median") params.set("arenaStatistic", next);
                  else params.delete("arenaStatistic");
                  window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`);
                }}
              >
                <option value="trimmed_mean">{t("arena.statistic.trimmedMean")}</option>
                <option value="median">{t("arena.statistic.median")}</option>
              </select>
            </label>
            {showFavorite && canCompareFavorite && (
              <label id="arena-favorite-picker" className="native-select min-w-[220px]">
                <span>{t("arena.favorite.label")}</span>
                <select
                  value={effectiveFavoriteAid == null ? "" : String(effectiveFavoriteAid)}
                  onChange={(event) => setSelectedFavoriteAid(event.target.value ? Number(event.target.value) : null)}
                >
                  {eligibleFavorites.map((favorite: Favorite) => <option key={favorite.aid} value={favorite.aid}>{favorite.nickname || `#${favorite.aid}`}</option>)}
                </select>
              </label>
            )}
          </div>
          <button
            type="button"
            aria-expanded={showFavorite}
            aria-controls="arena-favorite-picker"
            disabled={!canCompareFavorite}
            onClick={() => setShowFavorite((value) => !value)}
            className="min-h-11 rounded-full border border-[var(--card-border)] px-4 text-sm font-semibold text-[var(--foreground)] transition-colors hover:border-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {showFavorite ? t("arena.favorite.hideAll") : t("arena.favorite.compareAll")}
          </button>
        </div>
        <div className="mt-2 min-h-5 text-xs text-[var(--muted)]" aria-live="polite">
          {showFavorite && favoriteLoading
            ? t("arena.favorite.loading")
            : showFavorite && favoriteError
              ? t("arena.favorite.error")
              : !canCompareFavorite
                ? t(authStatus === "authenticated" ? "arena.favorite.empty" : "arena.favorite.authRequired")
                : showFavorite
                  ? t("arena.favorite.activeAll", { name: favoriteName ?? t("arena.favorite.label") })
                  : null}
        </div>
      </section>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)] xl:items-stretch">
        <section id="arena-comparison" tabIndex={-1} className="profile-anchor-section data-panel p-4 sm:p-5">
          <ArenaOverallComparison
            aid={numericAid}
            player={profile.overall}
            statistic={statistic}
            favorite={comparedFavorite?.overall ?? null}
            favoriteName={showFavorite ? favoriteName : null}
          />
        </section>
        <section id="arena-risk" tabIndex={-1} className="profile-anchor-section">
          <ArenaRiskPanel risk={risk} scope="overall" />
        </section>
      </div>

      <section id="arena-modes" tabIndex={-1} className="profile-anchor-section mt-5 space-y-4">
        <div className="data-panel p-4 sm:p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="section-kicker">{t("arena.modePicker.kicker")}</p>
              <h2 className="section-heading mt-1">{t("arena.modePicker.heading")}</h2>
            </div>
          </div>
          <div className="arena-mode-picker" role="group" aria-label={t("arena.modePicker.label") }>
            {ARENA_MODE_KEYS.map((mode) => {
              const matches = profile.modes[mode].counters.matches;
              return (
                <button
                  key={mode}
                  type="button"
                  className="arena-mode-picker__item"
                  aria-pressed={mode === selectedMode}
                  onClick={() => changeMode(mode)}
                >
                  <span className="arena-mode-picker__name">{t("arena.mode." + mode)}</span>
                  <span className="arena-mode-picker__count">{matches == null ? t("common.notAvailable") : t("arena.modePicker.matches", { n: matches.toLocaleString(lang) })}</span>
                </button>
              );
            })}
          </div>
        </div>

        <ArenaModeSection
          key={selectedMode}
          aid={numericAid}
          mode={selectedMode}
          profile={profile}
          statistic={statistic}
          risk={risk}
          favorite={comparedFavorite}
          favoriteName={showFavorite ? favoriteName : null}
        />
      </section>
      {error && <p className="mt-5 text-sm text-[var(--danger)]" role="status">{error}</p>}
    </main>
  );
}
