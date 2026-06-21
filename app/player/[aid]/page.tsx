"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { PlayerProfile, ParsedPlayerStats, SkillEntry } from "@/types/tarkov";
import StatCard from "@/components/StatCard";
import PlayerComparison from "@/components/PlayerComparison";
import EarlyUnlocks from "@/components/EarlyUnlocks";
import { useI18n } from "@/lib/i18n/context";

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

    fetch(`/api/player/profile?aid=${encodeURIComponent(aid)}`)
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

  const mainStats = [
    { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
    { label: t("player.level"), value: stats.level },
    { label: t("player.prestige"), value: stats.prestige },
    { label: t("player.totalRaids"), value: stats.totalRaids },
    { label: t("player.pmcRaids"), value: stats.pmcRaids },
    { label: t("player.scavRaids"), value: stats.scavRaids },
    { label: t("player.survivalRate"), value: `${stats.survivalRate}`, suffix: "%" },
    { label: t("player.kdAll"), value: stats.kdRatio },
    { label: t("player.pmcKd"), value: stats.pmcKdRatio },
    { label: t("player.totalKills"), value: stats.totalKills.toLocaleString() },
    { label: t("player.pmcKills"), value: stats.killedPmc.toLocaleString() },
    { label: t("player.killsPerRaid"), value: stats.killsPerRaid },
    { label: t("player.deaths"), value: stats.deaths.toLocaleString() },
    { label: t("player.runThroughs"), value: stats.runThrough },
    { label: t("player.winStreakPmc"), value: stats.longestWinStreak },
    { label: t("player.achievements"), value: stats.achievementsCount },
    { label: t("player.experience"), value: stats.experience.toLocaleString() },
  ];

  const skills: SkillEntry[] = profile.skills?.Common ?? [];
  const ownedAchievementIds = profile.achievements ? Object.keys(profile.achievements) : [];

  return (
    <main className="flex-1 px-4 py-8 max-w-7xl mx-auto w-full">
      <Link
        href="/"
        className="text-sm text-gray-500 hover:text-[var(--accent)] transition-colors mb-6 inline-block"
      >
        {t("common.back")}
      </Link>

      <div className="flex flex-col lg:flex-row gap-8">
        <div className="flex-1 space-y-6">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[var(--accent)]">
                {stats.nickname}
              </h1>
              <div className="flex flex-wrap gap-3 text-sm text-gray-500 mt-1">
                <span>{t("player.sideLabel", { side: stats.side })}</span>
                {stats.prestige > 0 && (
                  <span>{t("player.prestigeLabel", { n: stats.prestige })}</span>
                )}
                <span>#{aid}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {mainStats.map((s) => (
              <StatCard
                key={s.label}
                label={s.label}
                value={s.value}
                suffix={s.suffix}
              />
            ))}
          </div>

          {skills.length > 0 && (
            <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4">
              <h2 className="text-sm uppercase tracking-wider text-gray-500 mb-3">
                {t("player.skills")}
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                {skills
                  .filter((s) => s.Progress > 0)
                  .sort((a, b) => b.Progress - a.Progress)
                  .map((skill) => (
                    <div
                      key={skill.Id}
                      className="flex justify-between text-sm py-1 px-2 rounded bg-[var(--input-bg)]"
                    >
                      <span className="text-gray-400 truncate">
                        {skill.Id.replace(/([A-Z])/g, " $1").trim()}
                      </span>
                      <span className="text-[var(--accent)] ml-2">
                        {Math.floor(skill.Progress)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <EarlyUnlocks playerHours={stats.hoursPlayed} ownedIds={ownedAchievementIds} />
        </div>

        <div className="lg:w-96 shrink-0">
          <PlayerComparison stats={stats} turnstileToken="" />
        </div>
      </div>
    </main>
  );
}
