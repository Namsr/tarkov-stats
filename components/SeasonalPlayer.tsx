"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ProfileShell, { ProfileShellLoading } from "@/components/ProfileShell";
import PlayerRadarComparison from "@/components/PlayerRadarComparison";
import ProfileAchievements from "@/components/ProfileAchievements";
import ProfileSkills, { hasVisibleSkills } from "@/components/ProfileSkills";
import ProgressionPanel, { type ProgressionRiskPayload } from "@/components/ProgressionPanel";
import StatCard from "@/components/StatCard";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import CheaterScore from "@/components/CheaterScore";
import { useI18n } from "@/lib/i18n/context";
import { isReload } from "@/lib/is-reload";
import { isProfileStale } from "@/lib/profile-refresh-policy";
import { levelAtExperience, type LevelBand } from "@/lib/seasonal/ui";
import type { SeasonalProfile, SeasonalStats } from "@/types/seasonal";
import type { PublicRiskView, SeasonalAchievementView } from "@/types/profile-view";
import { upsertRecentPlayer } from "@/lib/recent-players";
import {
  getCachedPlayerProfileResponse,
  loadPlayerProfileResponse,
  PlayerProfileResponseError,
} from "@/lib/client-profile-request";

interface SeasonalProfileResponse {
  code?: string;
  error?: string;
  identity?: { aid?: number; mode?: string; cycleId?: string };
  profile?: SeasonalProfile;
  risk?: PublicRiskView | null;
  viewModel?: ProfileCollectionsViewModel;
}

interface ProfileCollectionsViewModel {
  risk?: PublicRiskView | null;
  achievements?: { items?: unknown[] };
  skills?: { items?: unknown[]; achievements?: unknown[]; kind?: string };
}

function displayNumber(value: number | null | undefined, digits = 1, fallback = ""): string {
  return value == null || !Number.isFinite(value)
    ? fallback
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function seasonalStatsFor(profile: SeasonalProfile, levelBands: LevelBand[]): SeasonalStats {
  const existing = profile.seasonalStats;
  const counters = profile.counters;
  const totalRaids = existing?.totalRaids ?? counters.pmcRaids + counters.scavRaids;
  const survivedRaids = existing?.survivedRaids ?? counters.pmcSurvived;
  const deaths = existing?.deaths ?? counters.pmcDeaths;
  const pmcKdRatio = existing?.pmcKdRatio ?? (counters.pmcDeaths > 0 ? counters.killedPmc / counters.pmcDeaths : null);
  const pmcSurvivalRate = existing?.pmcSurvivalRate ?? (counters.pmcRaids > 0 ? (counters.pmcSurvived / counters.pmcRaids) * 100 : null);
  const level = existing?.level ?? levelAtExperience(counters.experience, levelBands);
  return {
    totalRaids,
    survivedRaids,
    totalKills: existing?.totalKills ?? counters.pmcKills,
    deaths,
    runThrough: existing?.runThrough ?? null,
    survivalRate: existing?.survivalRate ?? (totalRaids && survivedRaids != null ? (survivedRaids / totalRaids) * 100 : null),
    kdRatio: existing?.kdRatio ?? (deaths && deaths > 0 && counters.pmcKills != null ? counters.pmcKills / deaths : null),
    pmcKdRatio,
    killsPerRaid: existing?.killsPerRaid ?? (counters.pmcRaids > 0 ? counters.pmcKills / counters.pmcRaids : null),
    pmcSurvivalRate,
    level,
    prestige: existing?.prestige ?? profile.staticSignals?.prestige ?? null,
    longestWinStreak: existing?.longestWinStreak ?? profile.staticSignals?.longestWinStreak ?? null,
    achievementsCount: existing?.achievementsCount ?? profile.staticSignals?.achievementIds.length ?? null,
  };
}

function achievementsFor(profile: SeasonalProfile): SeasonalAchievementView[] {
  const raw = (profile as SeasonalProfile & {
    seasonalAchievements?: unknown;
    achievements?: unknown;
  }).seasonalAchievements ?? (profile as SeasonalProfile & { achievements?: unknown }).achievements;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): SeasonalAchievementView[] => {
    if (typeof item === "string") {
      return [{ id: item, name: item, rarity: "common", unlockedAt: null, owners: null, eligibleN: null, percentage: null }];
    }
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id : null;
    if (!id) return [];
    return [{
      id,
      name: typeof value.name === "string" ? value.name : id,
      rarity: typeof value.rarity === "string" ? value.rarity : "common",
      unlockedAt: typeof value.unlockedAt === "number" ? value.unlockedAt : null,
      owners: typeof value.owners === "number" ? value.owners : null,
      eligibleN: typeof value.eligibleN === "number" ? value.eligibleN : null,
      percentage: typeof value.percentage === "number" ? value.percentage : null,
    }];
  });
}

function achievementsFromViewModel(
  viewModel: ProfileCollectionsViewModel | undefined,
): unknown[] | null {
  if (Array.isArray(viewModel?.achievements?.items)) return viewModel.achievements.items;
  if (Array.isArray(viewModel?.skills?.achievements)) return viewModel.skills.achievements;
  return null;
}

function skillsFromViewModel(viewModel: ProfileCollectionsViewModel | undefined): unknown[] | null {
  return Array.isArray(viewModel?.skills?.items) ? viewModel.skills.items : null;
}

function SeasonalProfileActions({
  aid,
  cycleId,
  nickname,
  stale = false,
  missing = false,
  onCheck,
}: {
  aid: number;
  cycleId: string;
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
          key={`${aid}:seasonal:${cycleId}`}
          aid={aid}
          mode="seasonal"
          stale={stale}
          missing={missing}
          onCheck={onCheck}
          className="whitespace-nowrap"
        />
        {stale && <p className="max-w-56 text-xs font-medium leading-snug text-[var(--danger)]">{t("player.refreshStaleMessage")}</p>}
      </div>
      <FavoriteButton aid={aid} nickname={nickname} identity={{ mode: "seasonal", cycleId }} />
      <CheaterReportButton aid={aid} mode="seasonal" cycle={cycleId} />
    </div>
  );
}

export default function SeasonalPlayer({
  aid,
  cycleId,
  levelBands,
}: {
  aid: number;
  cycleId: string;
  levelBands: LevelBand[];
}) {
  const { t, lang } = useI18n();
  const profileRequestUrl = `/api/player/profile?${new URLSearchParams({
    aid: String(aid),
    mode: "seasonal",
    cycle: cycleId,
  })}`;
  const cachedBody = getCachedPlayerProfileResponse<SeasonalProfileResponse>(profileRequestUrl)?.body;
  const initialProfile = cachedBody?.profile &&
    cachedBody.identity?.aid === aid &&
    cachedBody.identity.mode === "seasonal" &&
    cachedBody.identity.cycleId === cycleId
    ? cachedBody.profile
    : null;
  const [profile, setProfile] = useState<SeasonalProfile | null>(initialProfile);
  const [achievements, setAchievements] = useState<unknown[] | null>(
    initialProfile
      ? achievementsFromViewModel(cachedBody?.viewModel) ?? achievementsFor(initialProfile)
      : null,
  );
  const [skillItems, setSkillItems] = useState<unknown[] | null>(
    initialProfile ? skillsFromViewModel(cachedBody?.viewModel) : null,
  );
  const [serverRisk, setServerRisk] = useState<PublicRiskView | null>(
    initialProfile ? cachedBody?.viewModel?.risk ?? cachedBody?.risk ?? null : null,
  );
  const [progressionRisk, setProgressionRisk] = useState<ProgressionRiskPayload | null>(null);
  const [loading, setLoading] = useState(!initialProfile);
  const [error, setError] = useState("");
  const [modeUnavailable, setModeUnavailable] = useState(false);
  const [profileIsStale, setProfileIsStale] = useState(
    initialProfile ? isProfileStale(initialProfile.profileUpdatedAt) : false,
  );
  const [progressionRefreshRevision, setProgressionRefreshRevision] = useState(0);
  const [forceProgressionRefresh, setForceProgressionRefresh] = useState(false);
  const [displayNickname, setDisplayNickname] = useState<string | undefined>(initialProfile?.nickname);
  const refreshPromise = useRef<Promise<RefreshCheckResult> | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    requestGeneration.current += 1;
    const generation = requestGeneration.current;
    refreshPromise.current = null;
    const cached = getCachedPlayerProfileResponse<SeasonalProfileResponse>(profileRequestUrl)?.body;
    const cachedProfile = cached?.profile &&
      cached.identity?.aid === aid &&
      cached.identity.mode === "seasonal" &&
      cached.identity.cycleId === cycleId
      ? cached.profile
      : null;
    setLoading(!cachedProfile);
    setError("");
    setProgressionRisk(null);
    setModeUnavailable(false);
    setProgressionRefreshRevision(0);
    setForceProgressionRefresh(isReload());
    if (!cachedProfile) {
      setProfile((current) => {
        if (current?.nickname) setDisplayNickname(current.nickname);
        return null;
      });
      setAchievements(null);
      setSkillItems(null);
      setServerRisk(null);
      setProfileIsStale(false);
    }

    loadPlayerProfileResponse<SeasonalProfileResponse>(profileRequestUrl)
      .then(({ ok, body }) => {
        if (!ok || !body.profile) {
          if (body.code === "mode_profile_unavailable") {
            if (!cancelled && generation === requestGeneration.current) setModeUnavailable(true);
            return null;
          }
          throw new Error(body.error ?? t("seasonal.profileUnavailable"));
        }
        if (
          body.identity?.aid !== aid ||
          body.identity?.mode !== "seasonal" ||
          body.identity?.cycleId !== cycleId
        ) {
          throw new Error(t("seasonal.profileUnavailable"));
        }
        if (cancelled || generation !== requestGeneration.current) return null;
        setServerRisk(body.viewModel?.risk ?? body.risk ?? null);
        setAchievements(achievementsFromViewModel(body.viewModel) ?? achievementsFor(body.profile));
        setSkillItems(skillsFromViewModel(body.viewModel));
        return body.profile;
      })
      .then((nextProfile) => {
        if (cancelled || generation !== requestGeneration.current || !nextProfile) return;
        const nickname = nextProfile.nickname.trim();
        if (nickname) upsertRecentPlayer({ aid: String(aid), nickname, mode: "pvp-season", cycle: cycleId });
        setProfile(nextProfile);
        setDisplayNickname(nextProfile.nickname);
        setProfileIsStale(isProfileStale(nextProfile.profileUpdatedAt));
        setModeUnavailable(false);
      })
      .catch((caught: unknown) => {
        if (cancelled || generation !== requestGeneration.current) return;
        setError(caught instanceof PlayerProfileResponseError
          ? t("seasonal.profileUnavailable")
          : caught instanceof Error ? caught.message : t("seasonal.profileUnavailable"));
      })
      .finally(() => {
        if (!cancelled && generation === requestGeneration.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aid, cycleId, lang, profileRequestUrl, t]);

  const refreshProfile = useCallback(() => {
    if (refreshPromise.current) return refreshPromise.current;
    const generation = requestGeneration.current;
    const previousProfile = profile;
    const params = new URLSearchParams({ aid: String(aid), mode: "seasonal", cycle: cycleId, refresh: "1" });
    const request = loadPlayerProfileResponse<SeasonalProfileResponse>(
      `/api/player/profile?${params}`,
      { force: true },
    )
      .then(({ ok, body }): Promise<RefreshCheckResult> | RefreshCheckResult => {
        if (generation !== requestGeneration.current) return "unchanged";
        if (!ok || !body.profile) {
          if (body.code === "mode_profile_unavailable") {
            setModeUnavailable(true);
            setError("");
            return "unchanged";
          }
          throw new Error(body.error ?? t("seasonal.profileUnavailable"));
        }
        if (
          body.identity?.aid !== aid ||
          body.identity?.mode !== "seasonal" ||
          body.identity?.cycleId !== cycleId
        ) {
          throw new Error(t("seasonal.profileUnavailable"));
        }
        const nextProfile = body.profile;
        const changed = !previousProfile || previousProfile.profileUpdatedAt !== nextProfile.profileUpdatedAt || JSON.stringify(previousProfile) !== JSON.stringify(nextProfile);
        const nickname = nextProfile.nickname.trim();
        if (nickname) upsertRecentPlayer({ aid: String(aid), nickname, mode: "pvp-season", cycle: cycleId });
        setProfile(nextProfile);
        setDisplayNickname(nextProfile.nickname);
        setAchievements(achievementsFromViewModel(body.viewModel) ?? achievementsFor(nextProfile));
        setSkillItems(skillsFromViewModel(body.viewModel));
        setServerRisk(body.viewModel?.risk ?? body.risk ?? null);
        setModeUnavailable(false);
        setProfileIsStale(isProfileStale(nextProfile.profileUpdatedAt));
        setError("");
        setProgressionRefreshRevision((current) => current + 1);
        return changed ? "updated" : "unchanged";
      })
      .catch((error: unknown) => {
        if (error instanceof PlayerProfileResponseError) throw new Error(t("seasonal.profileUnavailable"));
        throw error;
      })
      .finally(() => {
        if (refreshPromise.current === request) refreshPromise.current = null;
      });
    refreshPromise.current = request;
    return request;
  }, [aid, cycleId, profile, t]);

  if (loading) return <ProfileShellLoading mode="seasonal" aid={aid} title={displayNickname} />;

  const unknownValue = t("common.unknown");
  const overviewLabels = [t("player.hoursPlayed"), t("player.pmcKd"), t("seasonal.pmcSurvival"), t("player.pmcRaids")];
  const emptySlot = <div className="data-panel min-h-44 p-5 text-sm text-[var(--muted)]">{t("common.notAvailable")}</div>;

  if (modeUnavailable || error || !profile) {
    return (
      <ProfileShell
        aid={aid}
        mode="seasonal"
        cycleId={cycleId}
        kicker={t("seasonal.profileKicker", { cycle: cycleId, aid })}
        title={displayNickname}
        actions={<SeasonalProfileActions aid={aid} cycleId={cycleId} nickname={displayNickname} missing={modeUnavailable} onCheck={refreshProfile} />}
        overviewCards={overviewLabels.map((label) => ({ label, value: unknownValue }))}
        progression={emptySlot}
        risk={emptySlot}
        comparison={emptySlot}
        statistics={emptySlot}
        achievements={emptySlot}
        skills={emptySlot}
        statusNotice={<div className="data-panel mt-5 p-5 text-center text-[var(--danger)]">{error || t("seasonal.profileUnavailable")}</div>}
      />
    );
  }

  const stats = seasonalStatsFor(profile, levelBands);
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  });
  const comparisonStats = {
    hoursPlayed: profile.lifetimePvpHours,
    pmcRaids: profile.counters.pmcRaids,
    kdRatio: stats.kdRatio,
    pmcKdRatio: stats.pmcKdRatio,
    killsPerRaid: stats.killsPerRaid,
    pmcSurvivalRate: stats.pmcSurvivalRate,
    longestWinStreak: stats.longestWinStreak,
    level: stats.level,
  };
  const statistics = (
    <div className="space-y-5">
      <section>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="section-heading">{t("player.raidStats")}</h2>
          <span className="section-kicker">{t("player.coreStats")}</span>
        </div>
        <div className="data-ledger">
          <StatCard label={t("player.totalRaids")} value={stats.totalRaids ?? unknownValue} />
          <StatCard label={t("player.pmcRaids")} value={profile.counters.pmcRaids} />
          <StatCard label={t("player.scavRaids")} value={profile.counters.scavRaids} />
          <StatCard label={t("player.pmcKills")} value={profile.counters.pmcKills} />
          <StatCard label={t("player.deaths")} value={stats.deaths ?? unknownValue} />
          <StatCard label={t("seasonal.metric.pvpKd")} value={displayNumber(stats.pmcKdRatio, 2, unknownValue)} />
          <StatCard label={t("seasonal.metric.survival")} value={displayNumber(stats.pmcSurvivalRate, 1, unknownValue)} suffix="%" />
        </div>
      </section>
      <section>
        <h2 className="section-heading mb-3">{t("player.progression")}</h2>
        <div className="detail-grid detail-grid--compact">
          <StatCard label={t("player.level")} value={stats.level ?? unknownValue} />
          <StatCard label={t("player.prestige")} value={stats.prestige ?? unknownValue} />
          <StatCard label={t("player.achievements")} value={stats.achievementsCount ?? unknownValue} />
          <StatCard label={t("player.experience")} value={profile.counters.experience.toLocaleString()} />
        </div>
      </section>
    </div>
  );

  return (
    <ProfileShell
      aid={aid}
      mode="seasonal"
      cycleId={cycleId}
      kicker={t("seasonal.profileKicker", { cycle: cycleId, aid })}
      title={profile.nickname}
      meta={
        <div className="profile-header__meta">
          <span>{t("player.sideLabel", { side: profile.side ?? unknownValue })}</span>
          {stats.prestige != null && stats.prestige > 0 && (
            <span>{t("player.prestigeLabel", { n: stats.prestige })}</span>
          )}
          <span>{t("player.profileUpdated", { date: dateTimeFormatter.format(profile.profileUpdatedAt) })}</span>
          <span>{t("player.lastPlayed", { date: dateTimeFormatter.format(profile.lastAccessAt) })}</span>
        </div>
      }
      actions={<SeasonalProfileActions aid={aid} cycleId={cycleId} nickname={profile.nickname} stale={profileIsStale} onCheck={refreshProfile} />}
      overviewCards={[
        { label: t("player.hoursPlayed"), value: displayNumber(profile.lifetimePvpHours, 1, unknownValue), suffix: t("unit.h") },
        { label: t("player.pmcKd"), value: displayNumber(stats.pmcKdRatio, 2, unknownValue) },
        { label: t("seasonal.pmcSurvival"), value: displayNumber(stats.pmcSurvivalRate, 1, unknownValue), suffix: "%" },
        { label: t("player.pmcRaids"), value: profile.counters.pmcRaids },
      ]}
      progression={<ProgressionPanel
        aid={aid}
        hours={profile.lifetimePvpHours ?? 0}
        pmcRaids={profile.counters.pmcRaids}
        mode="seasonal"
        cycleId={cycleId}
        profileUpdatedAt={profile.profileUpdatedAt}
        refreshRevision={progressionRefreshRevision}
        forceRefresh={forceProgressionRefresh}
        onRiskChange={setProgressionRisk}
      />}
      risk={<div><h2 className="section-heading mb-3">{t("cheater.heading")}</h2><CheaterScore risk={serverRisk ?? progressionRisk} mode="seasonal" cycleId={cycleId} /></div>}
      comparison={<PlayerRadarComparison aid={aid} stats={comparisonStats} mode="seasonal" cycleId={cycleId} />}
      statistics={statistics}
      achievements={
        <ProfileAchievements
          items={achievements}
          loading={achievements === null}
          playerHours={profile.lifetimePvpHours ?? 0}
          ownedIds={(achievements ?? []).flatMap((item) => {
            if (typeof item === "string") return [item];
            if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") return [(item as { id: string }).id];
            return [];
          })}
          mode="seasonal"
          cycleId={cycleId}
        />
      }
      skills={hasVisibleSkills(skillItems) ? <ProfileSkills skills={skillItems} /> : undefined}
    />
  );
}
