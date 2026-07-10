"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { PlayerProfile, ParsedPlayerStats, SkillEntry } from "@/types/tarkov";
import StatCard from "@/components/StatCard";
import PlayerComparison from "@/components/PlayerComparison";
import CheaterScore from "@/components/CheaterScore";
import EarlyUnlocks from "@/components/EarlyUnlocks";
import FavoriteButton from "@/components/FavoriteButton";
import RefreshButton from "@/components/RefreshButton";
import { useI18n } from "@/lib/i18n/context";
import { isReload } from "@/lib/is-reload";

interface Props {
  params: Promise<{ aid: string }>;
}

export default function PlayerPage({ params }: Props) {
  const { t } = useI18n();
  const { aid } = use(params);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [stats, setStats] = useState<ParsedPlayerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    // На перезагрузке (F5) обходим 5-мин кэш — «обновил на tarkov.dev → F5 → свежее».
    fetch(`/api/player/profile?aid=${encodeURIComponent(aid)}${isReload() ? "&refresh=1" : ""}`)
      .then(async (res) => {
        const data = (await res.json()) as {
          error?: string;
          profile?: PlayerProfile;
          stats?: ParsedPlayerStats;
        };
        if (!res.ok || !data.profile || !data.stats) {
          throw new Error(data.error ?? t("player.loadError"));
        }
        return { profile: data.profile, stats: data.stats };
      })
      .then((data) => {
        if (cancelled) return;
        setProfile(data.profile);
        setStats(data.stats);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("player.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [aid]);

  if (loading) {
    return (
      <main className="flex-1 px-4 py-8 max-w-7xl mx-auto w-full">
        <div className="animate-pulse space-y-6">
          <div className="h-8 w-48 skeleton rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-20 skeleton rounded-lg" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (error || !stats || !profile) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center px-4 gap-4">
        <p className="text-[var(--danger)] text-lg text-center max-w-md">
          {error || t("player.unknownError")}
        </p>
        <Link href="/" className="text-[var(--accent)] hover:underline">
          {t("common.back")}
        </Link>
      </main>
    );
  }

  const coreStats: { label: string; value: string | number; suffix?: string }[] = [
    { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
    { label: t("player.pmcKd"), value: stats.pmcKdRatio },
    { label: t("player.survivalRate"), value: `${stats.survivalRate}`, suffix: "%" },
    { label: t("player.killsPerRaid"), value: stats.killsPerRaid },
  ];

  const raidStats: { label: string; value: string | number; suffix?: string }[] = [
    { label: t("player.totalRaids"), value: stats.totalRaids },
    { label: t("player.pmcRaids"), value: stats.pmcRaids },
    { label: t("player.scavRaids"), value: stats.scavRaids },
    { label: t("player.kdAll"), value: stats.kdRatio },
    { label: t("player.totalKills"), value: stats.totalKills.toLocaleString() },
    { label: t("player.pmcKills"), value: stats.killedPmc.toLocaleString() },
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

  const skills: SkillEntry[] = profile.skills?.Common ?? [];
  const ownedAchievementIds = profile.achievements ? Object.keys(profile.achievements) : [];

  return (
    <main className="page-frame">
      <Link
        href="/"
        className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors mb-8 inline-block"
      >
        {t("common.back")}
      </Link>

      <section className="surface p-5 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="page-kicker">#{aid}</p>
            <h1 className="page-title break-words">{stats.nickname}</h1>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--muted)] mt-3">
              <span>{t("player.sideLabel", { side: stats.side })}</span>
              {stats.prestige > 0 && <span>{t("player.prestigeLabel", { n: stats.prestige })}</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton aid={Number(aid)} />
            <FavoriteButton aid={Number(aid)} nickname={stats.nickname} />
          </div>
        </div>

        <div className="mt-7 grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px] xl:items-stretch">
          <div className="detail-grid">
            {coreStats.map((item) => (
              <StatCard key={item.label} {...item} />
            ))}
          </div>
          <div className="data-panel flex items-center justify-center p-4">
            <PlayerComparison stats={stats} />
          </div>
        </div>
      </section>

      <div className="page-grid mt-5">
        <div className="space-y-5">
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

        <aside className="space-y-5">
          <CheaterScore stats={stats} ownedAchievementIds={ownedAchievementIds} />

          {skills.length > 0 && (
            <section className="data-panel p-5">
              <h2 className="section-heading text-base mb-4">{t("player.skills")}</h2>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-80 overflow-y-auto pr-1">
                {skills
                  .filter((s) => s.Progress > 0)
                  .sort((a, b) => b.Progress - a.Progress)
                  .map((skill) => (
                    <div key={skill.Id} className="flex min-w-0 justify-between gap-2 border-b border-[var(--card-border)] py-2 text-sm">
                      <span className="text-[var(--muted-strong)] truncate">
                        {skill.Id.replace(/([A-Z])/g, " $1").trim()}
                      </span>
                      <span className="text-[var(--accent)] tabular-nums">{Math.floor(skill.Progress)}</span>
                    </div>
                  ))}
              </div>
            </section>
          )}

          <EarlyUnlocks playerHours={stats.hoursPlayed} ownedIds={ownedAchievementIds} />
        </aside>
      </div>
    </main>
  );
}
