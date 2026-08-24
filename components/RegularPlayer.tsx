"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PlayerProfile, ParsedPlayerStats, SkillEntry } from "@/types/tarkov";
import StatCard from "@/components/StatCard";
import PlayerRadarComparison from "@/components/PlayerRadarComparison";
import CheaterScore from "@/components/CheaterScore";
import ProgressionPanel, { type ProgressionRiskPayload } from "@/components/ProgressionPanel";
import EarlyUnlocks from "@/components/EarlyUnlocks";
import ProfileAchievements from "@/components/ProfileAchievements";
import ProfileSkills, { hasVisibleSkills } from "@/components/ProfileSkills";
import ProfileMastering, { hasVisibleMastery } from "@/components/ProfileMastering";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import { useI18n } from "@/lib/i18n/context";
import { isReload } from "@/lib/is-reload";
import ProfileHeader from "@/components/ProfileHeader";
import ProfileSectionNav from "@/components/ProfileSectionNav";
import ProfileShell, { ProfileShellLoading } from "@/components/ProfileShell";
import type { CrossSectionMode } from "@/lib/db";
import { isProfileStale } from "@/lib/profile-refresh-policy";
import type { PublicRiskView } from "@/types/profile-view";
import { upsertRecentPlayer } from "@/lib/recent-players";
import {
  getCachedPlayerProfileResponse,
  loadPlayerProfileResponse,
  PlayerProfileResponseError,
} from "@/lib/client-profile-request";

interface Props {
  aid: string;
  radarDemo?: string | string[];
}

interface ProfileSummary {
  nickname: string;
  side?: string;
  prestige?: number;
}

interface ProfileCollectionsViewModel {
  risk?: PublicRiskView | null;
  achievements?: { items?: unknown[] };
  mastering?: { items?: unknown[] };
  skills?: { items?: unknown[]; achievements?: unknown[] };
}

interface RegularProfileResponse {
  code?: string;
  error?: string;
  profile?: PlayerProfile;
  stats?: ParsedPlayerStats;
  achievementIds?: string[];
  profileUpdatedAt?: number | null;
  profileSummary?: ProfileSummary;
  identity?: { aid?: number; mode?: string; cycleId?: string };
  risk?: PublicRiskView | null;
  viewModel?: ProfileCollectionsViewModel;
}

function viewModelAchievementItems(viewModel: ProfileCollectionsViewModel | null | undefined): unknown[] | null {
  if (Array.isArray(viewModel?.achievements?.items)) return viewModel.achievements.items;
  if (Array.isArray(viewModel?.skills?.achievements)) return viewModel.skills.achievements;
  return null;
}

function ProfileActions({
  aid,
  mode,
  nickname,
  stale = false,
  missing = false,
  onCheck,
}: {
  aid: number;
  mode: CrossSectionMode;
  nickname?: string;
  stale?: boolean;
  missing?: boolean;
  onCheck: () => Promise<RefreshCheckResult>;
}) {
  const { t } = useI18n();
  return (
    <div className="profile-actions-grid">
        <div className="profile-action-stack">
          <RefreshButton
            key={`${aid}:${mode}`}
            aid={aid}
            mode={mode}
            stale={stale}
            missing={missing}
            onCheck={onCheck}
            className="whitespace-nowrap"
          />
          {stale && (
            <p className="max-w-56 text-xs font-medium leading-snug text-[var(--danger)]">
              {t("player.refreshStaleMessage")}
            </p>
          )}
        </div>
        <FavoriteButton
          aid={aid}
          nickname={nickname}
          identity={{ mode, cycleId: "persistent" }}
        />
        <CheaterReportButton aid={aid} mode={mode} cycle="persistent" />
    </div>
  );
}

export default function RegularPlayer({
  aid,
  radarDemo: radarDemoValue,
  mode = "regular",
}: Props & { mode?: CrossSectionMode }) {
  const { t } = useI18n();
  const radarDemoParam = Array.isArray(radarDemoValue) ? radarDemoValue[0] : radarDemoValue;
  const radarDemo = process.env.NODE_ENV === "development" && radarDemoParam === "1";
  const profileRequestUrl = `/api/player/profile?${new URLSearchParams({ aid, mode })}`;
  const initialResponse = getCachedPlayerProfileResponse<RegularProfileResponse>(profileRequestUrl)?.body;
  const initialUpdatedAt = initialResponse?.profileUpdatedAt ?? null;
  const [profile, setProfile] = useState<PlayerProfile | null>(initialResponse?.profile ?? null);
  const [stats, setStats] = useState<ParsedPlayerStats | null>(initialResponse?.stats ?? null);
  const [achievementIds, setAchievementIds] = useState<string[]>(
    initialResponse?.achievementIds ??
      (initialResponse?.profile?.achievements ? Object.keys(initialResponse.profile.achievements) : []),
  );
  const [profileUpdatedAt, setProfileUpdatedAt] = useState<number | null>(initialUpdatedAt);
  const [profileIsStale, setProfileIsStale] = useState(isProfileStale(initialUpdatedAt));
  const [modeUnavailable, setModeUnavailable] = useState(false);
  const [profileSummary, setProfileSummary] = useState<ProfileSummary | null>(null);
  const [loading, setLoading] = useState(!initialResponse?.stats);
  const [error, setError] = useState("");
  const [progressionRisk, setProgressionRisk] = useState<ProgressionRiskPayload | null>(null);
  const [serverRisk, setServerRisk] = useState<PublicRiskView | null>(
    initialResponse?.viewModel?.risk ?? initialResponse?.risk ?? null,
  );
  const [viewModel, setViewModel] = useState<ProfileCollectionsViewModel | null>(initialResponse?.viewModel ?? null);
  const [progressionRefreshRevision, setProgressionRefreshRevision] = useState(0);
  const [forceProgressionRefresh, setForceProgressionRefresh] = useState(false);
  const refreshPromise = useRef<Promise<RefreshCheckResult> | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    requestGeneration.current += 1;
    refreshPromise.current = null;
    const cached = getCachedPlayerProfileResponse<RegularProfileResponse>(profileRequestUrl)?.body;
    setLoading(!cached?.stats);
    setError("");
    setModeUnavailable(false);
    setProfileSummary(null);
    setProgressionRisk(null);
    setForceProgressionRefresh(false);
    setViewModel(cached?.viewModel ?? null);
    if (!cached?.stats) {
      setProfile(null);
      setStats(null);
      setAchievementIds([]);
      setProfileUpdatedAt(null);
      setProfileIsStale(false);
      setServerRisk(null);
    }

    // На перезагрузке (F5) обходим 5-мин кэш — «обновил на tarkov.dev → F5 → свежее».
    const forceRefresh = isReload();
    setForceProgressionRefresh(forceRefresh);
    const requestParams = new URLSearchParams({ aid, mode });
    if (forceRefresh) requestParams.set("refresh", "1");
    loadPlayerProfileResponse<RegularProfileResponse>(`/api/player/profile?${requestParams}`, {
      force: forceRefresh,
    })
      .then(({ ok, body: data }) => {
        if (!ok || !data.stats) {
          const unavailable = data.code === "mode_profile_unavailable";
          if (unavailable) {
            if (!cancelled) {
              setModeUnavailable(true);
              setProfileSummary(data.profileSummary ?? null);
            }
            return null;
          }
          throw new Error(data.error ?? t("player.loadError"));
        }
        if ((mode === "regular" || mode === "pve") && (
          data.identity?.aid !== Number(aid) ||
          data.identity?.mode !== mode ||
          data.identity?.cycleId !== "persistent"
        )) {
          throw new Error(t("player.loadError"));
        }
        return { ...data, stats: data.stats };
      })
      .then((data) => {
        if (cancelled || !data) return;
        const nickname = data.stats.nickname.trim();
        if (nickname) upsertRecentPlayer({ aid: String(aid), nickname, mode });
        setProfile(data.profile ?? null);
        setStats(data.stats);
        setViewModel(data.viewModel ?? null);
        setAchievementIds(
          data.achievementIds ?? (data.profile?.achievements ? Object.keys(data.profile.achievements) : []),
        );
        const updatedAt = data.profileUpdatedAt ?? null;
        setProfileUpdatedAt(updatedAt);
        setProfileIsStale(isProfileStale(updatedAt));
        setServerRisk(data.viewModel?.risk ?? data.risk ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof PlayerProfileResponseError
            ? t("player.loadError")
            : err instanceof Error ? err.message : t("player.loadError"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [aid, mode, profileRequestUrl, t]);

  const refreshProfile = useCallback(() => {
    if (refreshPromise.current) return refreshPromise.current;

    const generation = requestGeneration.current;
    const previousStats = stats;
    const previousUpdatedAt = profileUpdatedAt;
    const requestParams = new URLSearchParams({ aid, mode, refresh: "1" });
    const request = loadPlayerProfileResponse<RegularProfileResponse>(
      `/api/player/profile?${requestParams}`,
      { force: true },
    )
      .then(({ ok, body: data }): Promise<RefreshCheckResult> | RefreshCheckResult => {
        if (generation !== requestGeneration.current) return "unchanged";
        if (!ok || !data.stats) {
          if (data.code === "mode_profile_unavailable") {
            setModeUnavailable(true);
            setProfileSummary(data.profileSummary ?? null);
            return "unchanged";
          }
          throw new Error(data.error ?? t("player.loadError"));
        }

        if ((mode === "regular" || mode === "pve") && (
          data.identity?.aid !== Number(aid) ||
          data.identity?.mode !== mode ||
          data.identity?.cycleId !== "persistent"
        )) {
          throw new Error(t("player.loadError"));
        }

        const updatedAt = data.profileUpdatedAt ?? data.stats.profileUpdatedAt ?? null;
        const changed =
          !previousStats ||
          updatedAt !== previousUpdatedAt ||
          JSON.stringify(data.stats) !== JSON.stringify(previousStats);
        const nickname = data.stats.nickname.trim();
        if (nickname) upsertRecentPlayer({ aid: String(aid), nickname, mode });
        setProfile(data.profile ?? null);
        setStats(data.stats);
        setViewModel(data.viewModel ?? null);
        setAchievementIds(
          data.achievementIds ?? (data.profile?.achievements ? Object.keys(data.profile.achievements) : []),
        );
        setProfileUpdatedAt(updatedAt);
        setProfileIsStale(isProfileStale(updatedAt));
        setModeUnavailable(false);
        setProfileSummary(null);
        setServerRisk(data.viewModel?.risk ?? data.risk ?? null);
        setError("");
        setProgressionRefreshRevision((current) => current + 1);
        return changed ? "updated" : "unchanged";
      })
      .catch((error: unknown) => {
        if (error instanceof PlayerProfileResponseError) throw new Error(t("player.loadError"));
        throw error;
      })
      .finally(() => {
        if (refreshPromise.current === request) refreshPromise.current = null;
      });
    refreshPromise.current = request;
    return request;
  }, [aid, mode, profileUpdatedAt, stats, t]);

  if (loading) {
    return <ProfileShellLoading mode={mode} aid={Number(aid)} title={stats?.nickname} />;
  }

  if (modeUnavailable) {
    if (mode === "regular" || mode === "pve") {
      const unknownValue = t("common.unknown");
      const overviewCards = [
        t("player.hoursPlayed"),
        mode === "pve" ? t("player.kdAll") : t("player.pmcKd"),
        t("player.survivalRate"),
        mode === "pve" ? t("player.totalRaids") : t("player.pmcRaids"),
      ].map((label) => ({ label, value: unknownValue }));
      const unavailableSlot = <div className="data-panel min-h-44 p-5 text-sm text-[var(--muted)]">{t("common.notAvailable")}</div>;
      return (
        <ProfileShell
          aid={Number(aid)}
          mode={mode}
          cycleId="persistent"
          kicker={`#${aid}`}
          title={mode === "regular" ? profileSummary?.nickname : undefined}
          meta={mode === "regular" && profileSummary?.side ? <div className="profile-header__meta">{t("player.sideLabel", { side: profileSummary.side })}</div> : undefined}
          actions={
            <ProfileActions
              aid={Number(aid)}
              mode={mode}
              nickname={mode === "regular" ? profileSummary?.nickname : undefined}
              missing
              onCheck={refreshProfile}
            />
          }
          overviewCards={overviewCards}
          progression={unavailableSlot}
          risk={unavailableSlot}
          comparison={unavailableSlot}
          statistics={unavailableSlot}
          achievements={unavailableSlot}
          skills={unavailableSlot}
          statusNotice={<div className="data-panel mt-5 p-5 text-center text-[var(--danger)]">{t("player.modeUnavailable")}</div>}
        />
      );
    }
    const unavailableStats = mode === "arena"
      ? [t("player.hoursPlayed"), t("arena.totalKills"), t("arena.totalDeaths"), t("arena.kdRatio")]
      : [t("player.hoursPlayed"), t("player.pmcKd"), t("player.survivalRate"), t("player.killsPerRaid")];
    return (
      <main className="page-frame">
        <Link
          href="/"
          className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors mb-8 inline-block"
        >
          {t("common.back")}
        </Link>

        <ProfileHeader
          aid={Number(aid)}
          mode={mode}
          kicker={`#${aid}`}
          title={profileSummary?.nickname}
          meta={mode !== "arena" && (profileSummary?.side || Number(profileSummary?.prestige) > 0) ? (
            <div className="profile-header__meta">
              {profileSummary?.side && <span>{t("player.sideLabel", { side: profileSummary.side })}</span>}
              {Number(profileSummary?.prestige) > 0 && (
                <span>{t("player.prestigeLabel", { n: Number(profileSummary?.prestige) })}</span>
              )}
            </div>
          ) : undefined}
          actions={
            <ProfileActions
              aid={Number(aid)}
              mode={mode}
              nickname={profileSummary?.nickname}
              missing
              onCheck={refreshProfile}
            />
          }
        >
          <div className="detail-grid mt-7">
            {unavailableStats.map((label) => <StatCard key={label} label={label} value="?" />)}
          </div>
        </ProfileHeader>

        <section className="data-panel mt-5 flex flex-col items-center gap-4 p-6 text-center">
          <p className="max-w-2xl text-[var(--danger)]">{t("player.modeUnavailable")}</p>
          <RefreshButton
            key={`${aid}:${mode}`}
            aid={Number(aid)}
            mode={mode}
            missing
            onCheck={refreshProfile}
          />
        </section>
      </main>
    );
  }

  if (error || !stats) {
    if (mode === "regular" || mode === "pve") {
      const errorSlot = <div className="data-panel min-h-44 p-5 text-sm text-[var(--danger)]">{error || t("player.unknownError")}</div>;
      return (
        <ProfileShell
          aid={Number(aid)}
          mode={mode}
          cycleId="persistent"
          kicker={`#${aid}`}
          title={mode === "regular" ? profileSummary?.nickname : undefined}
          actions={<ProfileActions aid={Number(aid)} mode={mode} nickname={mode === "regular" ? profileSummary?.nickname : undefined} onCheck={refreshProfile} />}
          overviewCards={[
            t("player.hoursPlayed"),
            mode === "pve" ? t("player.kdAll") : t("player.pmcKd"),
            t("player.survivalRate"),
            mode === "pve" ? t("player.totalRaids") : t("player.pmcRaids"),
          ].map((label) => ({ label, value: t("common.unknown") }))}
          progression={errorSlot}
          risk={errorSlot}
          comparison={errorSlot}
          statistics={errorSlot}
          achievements={errorSlot}
          skills={errorSlot}
          statusNotice={<div className="data-panel mt-5 p-5 text-center">{error || t("player.unknownError")}</div>}
        />
      );
    }
    return (
      <main className="page-frame">
        <Link href="/" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors mb-8 inline-block">
          {t("common.back")}
        </Link>
        <ProfileHeader
          aid={Number(aid)}
          mode={mode}
          kicker={`#${aid}`}
          title={profileSummary?.nickname}
          actions={<ProfileActions aid={Number(aid)} mode={mode} nickname={profileSummary?.nickname} onCheck={refreshProfile} />}
        >
          <div className="detail-grid mt-7">
            {Array.from({ length: 4 }).map((_, index) => <StatCard key={index} label={t("common.unknown")} value="?" />)}
          </div>
        </ProfileHeader>
        <div className="data-panel mt-5 p-5 text-center text-[var(--danger)]" role="status">
          {error || t("player.unknownError")}
        </div>
      </main>
    );
  }

  const arena = stats.arena;
  const pvpStatsKnown = stats.pvpStatsKnown !== false;
  const coreStats: { label: string; value: string | number; suffix?: string }[] =
    mode === "arena"
      ? [
          { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
          { label: t("arena.totalKills"), value: arena?.totalKills.toLocaleString() ?? "—" },
          { label: t("arena.totalDeaths"), value: arena?.totalDeaths.toLocaleString() ?? "—" },
          { label: t("arena.kdRatio"), value: arena?.kdRatio ?? "—" },
        ]
      : mode === "pve"
        ? [
            { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
            { label: t("player.kdAll"), value: stats.kdRatio },
            { label: t("player.survivalRate"), value: `${stats.survivalRate}`, suffix: "%" },
            { label: t("player.killsPerRaid"), value: stats.killsPerRaid },
          ]
      : [
          { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
          { label: t("player.pmcKd"), value: pvpStatsKnown ? stats.pmcKdRatio : t("common.notAvailable") },
          { label: t("player.survivalRate"), value: `${stats.survivalRate}`, suffix: "%" },
          { label: t("player.killsPerRaid"), value: stats.killsPerRaid },
        ];

  const raidStats: { label: string; value: string | number; suffix?: string }[] = [
    { label: t("player.totalRaids"), value: stats.totalRaids },
    { label: t("player.pmcRaids"), value: stats.pmcRaids },
    { label: t("player.scavRaids"), value: stats.scavRaids },
    { label: t("player.kdAll"), value: stats.kdRatio },
    { label: t("player.totalKills"), value: stats.totalKills.toLocaleString() },
    { label: t("player.pmcKills"), value: pvpStatsKnown ? stats.killedPmc.toLocaleString() : t("common.notAvailable") },
    { label: t("player.deaths"), value: stats.deaths.toLocaleString() },
    { label: t("player.runThroughs"), value: stats.runThrough },
    { label: t("player.outcome.killed"), value: stats.pmcExitKilled },
    { label: t("player.outcome.left"), value: stats.pmcExitLeft },
    { label: t("player.outcome.transit"), value: stats.pmcExitTransit },
    { label: t("player.winStreakPmc"), value: stats.longestWinStreak },
  ];
  // MissingInAction is effectively retired in current wipes; surface it only when nonzero.
  if (stats.pmcExitMia > 0) {
    raidStats.push({ label: t("player.outcome.mia"), value: stats.pmcExitMia });
  }

  const progressionStats: { label: string; value: string | number; suffix?: string }[] = [
    { label: t("player.level"), value: stats.level },
    { label: t("player.prestige"), value: stats.prestige },
    { label: t("player.achievements"), value: stats.achievementsCount },
    { label: t("player.experience"), value: stats.experience.toLocaleString() },
  ];

  const skills: SkillEntry[] = profile?.skills?.Common ?? [];
  const lastPlayedAt = Number(stats.lastPlayedAt) || null;
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  });
  const sectionLinks = mode === "arena"
    ? [
        { id: "overview", label: t("profile.section.overview") },
        { id: "overall", label: t("profile.section.overall") },
        { id: "statistics", label: t("profile.section.statistics") },
      ]
    : [
        { id: "overview", label: t("profile.section.overview") },
        ...(mode === "regular"
          ? [{ id: "progression", label: t("profile.section.progression") }]
          : []),
        { id: "risk", label: t("profile.section.risk") },
        { id: "comparison", label: t("profile.section.comparison") },
        { id: "statistics", label: t("profile.section.statistics") },
        ...(skills.length > 0
          ? [{ id: "skills", label: t("profile.section.skills") }]
          : []),
      ];

  if (mode === "regular" || mode === "pve") {
    const regularOverviewCards = mode === "pve"
      ? [
          { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
          { label: t("player.kdAll"), value: stats.kdRatio },
          { label: t("player.survivalRate"), value: stats.survivalRate, suffix: "%" },
          { label: t("player.totalRaids"), value: stats.totalRaids },
        ]
      : [
          { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
          { label: t("player.pmcKd"), value: pvpStatsKnown ? stats.pmcKdRatio : t("common.notAvailable") },
          { label: t("player.survivalRate"), value: pvpStatsKnown ? stats.pmcSurvivalRate : t("common.notAvailable"), suffix: "%" },
          { label: t("player.pmcRaids"), value: stats.pmcRaids },
        ];
    const regularStatistics = (
      <div className="space-y-5">
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="section-heading">{t("player.raidStats")}</h2>
            <span className="section-kicker">{t("player.coreStats")}</span>
          </div>
          <div className="data-ledger">
            {raidStats.map((item) => <StatCard key={item.label} {...item} />)}
          </div>
        </section>
        <section>
          <h2 className="section-heading mb-3">{t("player.progression")}</h2>
          <div className="detail-grid detail-grid--compact">
            {progressionStats.map((item) => <StatCard key={item.label} {...item} />)}
          </div>
        </section>
      </div>
    );
    const regularAchievementItems = viewModelAchievementItems(viewModel) ?? Object.entries(profile?.achievements ?? {}).map(([id, unlockedAt]) => ({
      id,
      unlockedAt,
    }));
    const regularSkillItems = viewModel?.skills?.items ?? skills;
    const masteryItems = viewModel?.mastering?.items ?? [];

    return (
      <ProfileShell
        aid={Number(aid)}
        mode={mode}
        cycleId="persistent"
        kicker={`#${aid}`}
        title={stats.nickname}
        meta={
          <div className="profile-header__meta">
            <span>{t("player.sideLabel", { side: stats.side })}</span>
            {stats.prestige > 0 && <span>{t("player.prestigeLabel", { n: stats.prestige })}</span>}
            {profileUpdatedAt !== null && <span>{t("player.profileUpdated", { date: dateTimeFormatter.format(profileUpdatedAt) })}</span>}
            {lastPlayedAt !== null && <span>{t("player.lastPlayed", { date: dateTimeFormatter.format(lastPlayedAt) })}</span>}
          </div>
        }
        actions={<ProfileActions aid={Number(aid)} mode={mode} nickname={stats.nickname} stale={profileIsStale} onCheck={refreshProfile} />}
        overviewCards={regularOverviewCards}
        progression={<ProgressionPanel
          aid={Number(aid)}
          hours={stats.hoursPlayed}
          pmcRaids={stats.pmcRaids}
          mode={mode}
          cycleId="persistent"
          profileUpdatedAt={profileUpdatedAt}
          refreshRevision={progressionRefreshRevision}
          forceRefresh={forceProgressionRefresh}
          onRiskChange={setProgressionRisk}
        />}
        risk={<div><h2 className="section-heading mb-3">{t("cheater.heading")}</h2><CheaterScore risk={serverRisk ?? progressionRisk} mode={mode} cycleId="persistent" statsKnown={mode === "regular" ? pvpStatsKnown : true} /></div>}
        comparison={<PlayerRadarComparison aid={Number(aid)} stats={stats} mode={mode} cycleId="persistent" demo={radarDemo} />}
        statistics={regularStatistics}
        achievements={
          <ProfileAchievements
            items={regularAchievementItems}
            playerHours={stats.hoursPlayed}
            ownedIds={achievementIds}
            mode={mode}
            cycleId="persistent"
          />
        }
        mastering={hasVisibleMastery(masteryItems) ? <ProfileMastering items={masteryItems} /> : undefined}
        skills={hasVisibleSkills(regularSkillItems) ? <ProfileSkills skills={regularSkillItems} /> : undefined}
      />
    );
  }

  return (
    <main className="page-frame">
      <Link
        href="/"
        className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors mb-8 inline-block"
      >
        {t("common.back")}
      </Link>

      <ProfileSectionNav label={t("profile.sectionNav")} items={sectionLinks} />

      <ProfileHeader
        aid={Number(aid)}
        mode={mode}
        kicker={`#${aid}`}
        title={stats.nickname}
        meta={
          <div className="profile-header__meta">
            {mode !== "arena" && <span>{t("player.sideLabel", { side: stats.side })}</span>}
            {mode !== "arena" && stats.prestige > 0 && (
              <span>{t("player.prestigeLabel", { n: stats.prestige })}</span>
            )}
            {profileUpdatedAt !== null && (
              <span>
                {t("player.profileUpdated", {
                  date: dateTimeFormatter.format(profileUpdatedAt),
                })}
              </span>
            )}
            {lastPlayedAt !== null && (
              <span>
                {t("player.lastPlayed", { date: dateTimeFormatter.format(lastPlayedAt) })}
              </span>
            )}
          </div>
        }
        actions={
          <ProfileActions
            aid={Number(aid)}
            mode={mode}
            nickname={stats.nickname}
            stale={profileIsStale}
            onCheck={refreshProfile}
          />
        }
      >
        <div className="detail-grid mt-7">
          {coreStats.map((item) => (
            <StatCard key={item.label} {...item} />
          ))}
        </div>
      </ProfileHeader>

      {mode === "arena" ? (
        <div className="mt-5 space-y-5">
          <section id="overall" tabIndex={-1} className="profile-anchor-section">
            <h2 className="section-heading mb-3">{t("arena.overall")}</h2>
            <div className="data-ledger">
              {[
                { label: t("arena.currentKillStreak"), value: arena?.currentKillStreak ?? "—" },
                { label: t("arena.maxKillStreak"), value: arena?.maxKillStreak ?? "—" },
                { label: t("arena.maxWinStreak"), value: arena?.maxWinStreak ?? "—" },
                { label: t("arena.bestArp"), value: arena?.bestArp ?? "—" },
                { label: t("arena.currentLossStreak"), value: arena?.currentLossStreak ?? "—" },
                { label: t("arena.maxLossStreak"), value: arena?.maxLossStreak ?? "—" },
              ].map((item) => (
                <StatCard key={item.label} {...item} />
              ))}
            </div>
          </section>

          <section id="statistics" tabIndex={-1} className="profile-anchor-section">
            <h2 className="section-heading mb-3">{t("arena.byMode")}</h2>
            <div className="data-panel overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
                    <th scope="col" className="px-4 py-3 font-medium">{t("arena.mode")}</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">{t("arena.totalKills")}</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">{t("arena.totalDeaths")}</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">{t("arena.kdRatio")}</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">{t("arena.maxKillStreak")}</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">{t("arena.roundMvp")}</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">{t("arena.matchMvp")}</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">{t("arena.maxWinStreak")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(arena?.modes ?? []).map((row) => (
                    <tr key={row.key} className="border-b border-[var(--card-border)] last:border-0">
                      <th scope="row" className="px-4 py-3 text-left font-medium text-[var(--foreground)]">
                        {t("arena.mode." + row.key)}
                      </th>
                      {[row.kills, row.deaths, row.kdRatio, row.maxKillStreak, row.roundMvp, row.matchMvp, row.maxWinStreak].map(
                        (value, index) => (
                          <td key={index} className="px-3 py-3 text-right tabular-nums text-[var(--muted-strong)] last:pr-4">
                            {value}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : (
        <>
          <section id="risk" tabIndex={-1} className="profile-anchor-section mt-5">
            <h2 className="section-heading mb-3">{t("cheater.heading")}</h2>
            <CheaterScore
              risk={serverRisk}
              stats={stats}
              ownedAchievementIds={achievementIds}
              mode={mode}
              cycleId="persistent"
            />
          </section>

          <section id="comparison" tabIndex={-1} className="profile-anchor-section mt-5">
            <PlayerRadarComparison aid={Number(aid)} stats={stats} mode={mode} demo={radarDemo} />
          </section>

          <div id="statistics" tabIndex={-1} className="profile-anchor-section mt-5 space-y-5">
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="section-heading">{t("player.raidStats")}</h2>
            <span className="section-kicker">{t("player.coreStats")}</span>
          </div>
          <div className="data-ledger">
            {raidStats.map((item) => (
              <StatCard key={item.label} {...item} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="section-heading mb-3">{t("player.progression")}</h2>
          <div className="detail-grid detail-grid--compact">
            {progressionStats.map((item) => (
              <StatCard key={item.label} {...item} />
            ))}
          </div>
        </section>
      </div>

          {skills.length > 0 ? (
        <div id="skills" tabIndex={-1} className="profile-anchor-section page-grid mt-5">
          <section className="data-panel p-5">
            <h2 className="section-heading text-base mb-4">{t("player.skills")}</h2>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-80 overflow-y-auto pr-1">
              {skills
                .filter((s) => s.Progress > 0)
                .sort((a, b) => b.Progress - a.Progress)
                .map((skill) => (
                  <div
                    key={skill.Id}
                    className="flex min-w-0 justify-between gap-2 border-b border-[var(--card-border)] py-2 text-sm"
                  >
                    <span className="text-[var(--muted-strong)] truncate">
                      {skill.Id.replace(/([A-Z])/g, " $1").trim()}
                    </span>
                    <span className="text-[var(--accent)] tabular-nums">
                      {Math.floor(skill.Progress)}
                    </span>
                  </div>
                ))}
            </div>
          </section>

          <aside>
            <EarlyUnlocks playerHours={stats.hoursPlayed} ownedIds={achievementIds} mode={mode} />
          </aside>
        </div>
          ) : (
        <div className="mt-5 ml-auto max-w-[360px]">
          <EarlyUnlocks playerHours={stats.hoursPlayed} ownedIds={achievementIds} mode={mode} />
        </div>
          )}
        </>
      )}
    </main>
  );
}
