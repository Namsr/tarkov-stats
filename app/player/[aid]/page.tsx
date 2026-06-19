"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { PlayerProfile, ParsedPlayerStats, SkillEntry } from "@/types/tarkov";
import StatCard from "@/components/StatCard";
import PlayerComparison from "@/components/PlayerComparison";

interface Props {
  params: Promise<{ aid: string }>;
}

export default function PlayerPage({ params }: Props) {
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
          throw new Error(data.error ?? "Failed to load profile");
        }
        return { profile: data.profile, stats: data.stats };
      })
      .then((data) => {
        if (cancelled) return;
        setProfile(data.profile);
        setStats(data.stats);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load profile");
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
          {error || "Unknown error"}
        </p>
        <Link href="/" className="text-[var(--accent)] hover:underline">
          Back to search
        </Link>
      </main>
    );
  }

  const mainStats = [
    { label: "Hours Played", value: stats.hoursPlayed },
    { label: "Level", value: stats.level },
    { label: "Prestige", value: stats.prestige },
    { label: "Total Raids", value: stats.totalRaids },
    { label: "PMC Raids", value: stats.pmcRaids },
    { label: "Scav Raids", value: stats.scavRaids },
    { label: "Survival Rate", value: `${stats.survivalRate}`, suffix: "%" },
    { label: "K/D (all)", value: stats.kdRatio },
    { label: "PMC K/D", value: stats.pmcKdRatio },
    { label: "Total Kills", value: stats.totalKills.toLocaleString() },
    { label: "PMC Kills", value: stats.killedPmc.toLocaleString() },
    { label: "Kills / Raid", value: stats.killsPerRaid },
    { label: "Deaths", value: stats.deaths.toLocaleString() },
    { label: "Run-throughs", value: stats.runThrough },
    { label: "Win Streak (PMC)", value: stats.longestWinStreak },
    { label: "Achievements", value: stats.achievementsCount },
    { label: "Experience", value: stats.experience.toLocaleString() },
  ];

  const skills: SkillEntry[] = profile.skills?.Common ?? [];

  return (
    <main className="flex-1 px-4 py-8 max-w-7xl mx-auto w-full">
      <Link
        href="/"
        className="text-sm text-gray-500 hover:text-[var(--accent)] transition-colors mb-6 inline-block"
      >
        &larr; Back to search
      </Link>

      <div className="flex flex-col lg:flex-row gap-8">
        <div className="flex-1 space-y-6">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[var(--accent)]">
                {stats.nickname}
              </h1>
              <div className="flex flex-wrap gap-3 text-sm text-gray-500 mt-1">
                <span>Side: {stats.side}</span>
                {stats.prestige > 0 && <span>Prestige {stats.prestige}</span>}
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
                Skills
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
        </div>

        <div className="lg:w-96 shrink-0">
          <PlayerComparison stats={stats} turnstileToken="" />
        </div>
      </div>
    </main>
  );
}
