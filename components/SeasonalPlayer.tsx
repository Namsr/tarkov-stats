"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ProfileShell, { ProfileShellLoading } from "@/components/ProfileShell";
import PlayerRadarComparison from "@/components/PlayerRadarComparison";
import SeasonalAchievements from "@/components/SeasonalAchievements";
import ProgressionPanel, { type ProgressionRiskPayload } from "@/components/ProgressionPanel";
import StatCard from "@/components/StatCard";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import RefreshButton, { type RefreshCheckResult } from "@/components/RefreshButton";
import CheaterScore from "@/components/CheaterScore";
import { useI18n } from "@/lib/i18n/context";
import { isProfileStale } from "@/lib/profile-refresh-policy";
import { levelAtExperience, type LevelBand } from "@/lib/seasonal/ui";
import type { SeasonalProfile, SeasonalStats } from "@/types/seasonal";
import type { PublicRiskView, SeasonalAchievementView } from "@/types/profile-view";
import type { PlayerProfileViewModel, ProfileViewAchievement } from "@/types/player-profile-view";

interface SeasonalProfileResponse {
  code?: string;
  error?: string;
  identity?: { aid?: number; mode?: string; cycleId?: string };
  profile?: SeasonalProfile;
  risk?: PublicRiskView | null;
  viewModel?: PlayerProfileViewModel;
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
  const pmcKdRatio = existing?.pmcKdRatio ?? (counters.pmcDeaths > 0 ? counters.pmcKills / counters.pmcDeaths : null);
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
  viewModel: PlayerProfileViewModel | undefined,
  lang: "en" | "ru",
): SeasonalAchievementView[] | null {
  if (!viewModel || viewModel.skills.kind !== "seasonal") return null;
  return viewModel.skills.achievements.map((achievement: ProfileViewAchievement) => ({
    id: achievement.id,
    name: (lang === "ru" ? achievement.nameRu : achievement.name) ?? achievement.id,
    nameRu: achievement.nameRu,
    rarity: achievement.rarity ?? "common",
    unlockedAt: achievement.unlockedAt,
    owners: achievement.owners,
    eligibleN: achievement.eligibleN,
    percentage: achievement.percentage,
  }));
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
  const [profile, setProfile] = useState<SeasonalProfile | null>(null);
  const [achievements, setAchievements] = useState<SeasonalAchievementView[] | null>(null);
  const [serverRisk, setServerRisk] = useState<PublicRiskView | null>(null);
  const [progressionRisk, setProgressionRisk] = useState<ProgressionRiskPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modeUnavailable, setModeUnavailable] = useState(false);
  const [profileIsStale, setProfileIsStale] = useState(false);
  const [progressionRefreshRevision, setProgressionRefreshRevision] = useState(0);
  const [displayNickname, setDisplayNickname] = useState<string | undefined>();
  const refreshPromise = useRef<Promise<RefreshCheckResult> | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    requestGeneration.current += 1;
    refreshPromise.current = null;
    setLoading(true);
    setError("");
    setProfile((current) => {
      if (current?.nickname) setDisplayNickname(current.nickname);
      return null;
    });
    setAchievements(null);
    setServerRisk(null);
    setProgressionRisk(null);
    setModeUnavailable(false);
    setProfileIsStale(false);
    setProgressionRefreshRevision(0);

    const params = new URLSearchParams({ aid: String(aid), mode: "seasonal", cycle: cycleId });
    fetch(`/api/player/profile?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as SeasonalProfileResponse;
        if (!response.ok || !body.profile) {
          if (body.code === "mode_profile_unavailable") {
            setModeUnavailable(true);
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
        setServerRisk(body.viewModel?.risk ?? body.risk ?? null);
        setAchievements(achievementsFromViewModel(body.viewModel, lang) ?? achievementsFor(body.profile));
        return body.profile;
      })
      .then((nextProfile) => {
        if (!nextProfile) return;
        setProfile(nextProfile);
        setDisplayNickname(nextProfile.nickname);
        setProfileIsStale(isProfileStale(nextProfile.profileUpdatedAt));
        setModeUnavailable(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : t("seasonal.profileUnavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [aid, cycleId, lang, t]);

  const refreshProfile = useCallback(() => {
    if (refreshPromise.current) return refreshPromise.current;
    const generation = requestGeneration.current;
    const previousProfile = profile;
    const params = new URLSearchParams({ aid: String(aid), mode: "seasonal", cycle: cycleId, refresh: "1" });
    const request = fetch(`/api/player/profile?${params}`, { cache: "no-store" })
      .then(async (response): Promise<RefreshCheckResult> => {
        const body = (await response.json()) as SeasonalProfileResponse;
        if (generation !== requestGeneration.current) return "unchanged";
        if (!response.ok || !body.profile) {
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
        setProfile(nextProfile);
        setDisplayNickname(nextProfile.nickname);
        setAchievements(achievementsFromViewModel(body.viewModel, lang) ?? achievementsFor(nextProfile));
        setServerRisk(body.viewModel?.risk ?? body.risk ?? null);
        setModeUnavailable(false);
        setProfileIsStale(isProfileStale(nextProfile.profileUpdatedAt));
        setError("");
        setProgressionRefreshRevision((current) => current + 1);
        return changed ? "updated" : "unchanged";
      })
      .finally(() => {
        if (refreshPromise.current === request) refreshPromise.current = null;
      });
    refreshPromise.current = request;
    return request;
  }, [aid, cycleId, lang, profile, t]);

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
        skills={emptySlot}
        statusNotice={<div className="data-panel mt-5 p-5 text-center text-[var(--danger)]">{error || t("seasonal.profileUnavailable")}</div>}
      />
    );
  }

  const stats = seasonalStatsFor(profile, levelBands);
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
    <div className="data-ledger">
      <StatCard label={t("player.totalRaids")} value={stats.totalRaids ?? unknownValue} />
      <StatCard label={t("player.pmcRaids")} value={profile.counters.pmcRaids} />
      <StatCard label={t("player.scavRaids")} value={profile.counters.scavRaids} />
      <StatCard label={t("player.pmcKills")} value={profile.counters.pmcKills} />
      <StatCard label={t("player.deaths")} value={stats.deaths ?? unknownValue} />
      <StatCard label={t("seasonal.metric.pvpKd")} value={displayNumber(stats.pmcKdRatio, 2, unknownValue)} />
      <StatCard label={t("seasonal.metric.survival")} value={displayNumber(stats.pmcSurvivalRate, 1, unknownValue)} suffix="%" />
      <StatCard label={t("player.level")} value={stats.level ?? unknownValue} />
      <StatCard label={t("player.experience")} value={profile.counters.experience.toLocaleString()} />
      <StatCard label={t("player.achievements")} value={stats.achievementsCount ?? unknownValue} />
    </div>
  );

  return (
    <ProfileShell
      aid={aid}
      mode="seasonal"
      cycleId={cycleId}
      kicker={t("seasonal.profileKicker", { cycle: cycleId, aid })}
      title={profile.nickname}
      meta={<div className="profile-header__meta"><span>{t("seasonal.lastUpdated")}: {new Date(profile.profileUpdatedAt).toLocaleDateString(undefined, { timeZone: "Europe/Moscow" })}</span></div>}
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
        onRiskChange={setProgressionRisk}
      />}
      risk={<div><h2 className="section-heading mb-3">{t("cheater.heading")}</h2><CheaterScore risk={serverRisk ?? progressionRisk} mode="seasonal" cycleId={cycleId} /></div>}
      comparison={<PlayerRadarComparison aid={aid} stats={comparisonStats} mode="seasonal" cycleId={cycleId} />}
      statistics={statistics}
      skills={<SeasonalAchievements achievements={achievements ?? []} loading={achievements === null} />}
    />
  );
}
