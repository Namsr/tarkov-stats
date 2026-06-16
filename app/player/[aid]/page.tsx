"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { getProfileDirect } from "@/lib/player-api-client";
import { parseProfileStats } from "@/lib/tarkov-api";
import { PlayerProfile, ParsedPlayerStats, SkillEntry } from "@/types/tarkov";
import StatCard from "@/components/StatCard";
import PlayerComparison from "@/components/PlayerComparison";
import TurnstileWidget from "@/components/TurnstileWidget";

interface Props {
  params: Promise<{ aid: string }>;
}

export default function PlayerPage({ params }: Props) {
  const { aid } = use(params);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [stats, setStats] = useState<ParsedPlayerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");

  useEffect(() => {
    if (!turnstileToken) return;

    const aidNum = Number(aid);
    if (isNaN(aidNum)) {
      setError("Invalid player ID");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");

    getProfileDirect(aidNum, turnstileToken)
      .then((data) => {
        setProfile(data);
        setStats(parseProfileStats(data));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load profile"))
      .finally(() => setLoading(false));
  }, [aid, turnstileToken]);

  if (!turnstileToken) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center px-4 gap-6">
        <div className="text-center space-y-2">
          <h2 className="text-lg font-bold text-[var(--accent)]">Verification Required</h2>
          <p className="text-gray-400 text-sm">Complete the check below to view player stats</p>
        </div>
        <TurnstileWidget onToken={setTurnstileToken} />
      </main>
    );
  }

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
        <p className="text-[var(--danger)] text-lg">{error || "Unknown error"}</p>
        <Link href="/" className="text-[var(--accent)] hover:underline">
          Back to search
        </Link>
      </main>
    );
  }

  const mainStats = [
    { label: "Total Raids", value: stats.totalRaids },
    { label: "PMC Raids", value: stats.pmcRaids },
    { label: "Scav Raids", value: stats.scavRaids },
    { label: "Survival Rate", value: `${stats.survivalRate}`, suffix: "%" },
    { label: "K/D Ratio", value: stats.kdRatio },
    { label: "Total Kills", value: stats.totalKills.toLocaleString() },
    { label: "Kills / Raid", value: stats.killsPerRaid },
    { label: "Deaths", value: stats.deaths.toLocaleString() },
    { label: "Headshot Rate", value: `${stats.headshotRate}`, suffix: "%" },
    { label: "Hours Played", value: stats.hoursPlayed },
    { label: "Avg Lifespan", value: `${stats.avgLifespan}`, suffix: " min" },
    { label: "Win Streak", value: stats.longestWinStreak },
    { label: "Level", value: stats.level },
    { label: "Experience", value: stats.experience.toLocaleString() },
    { label: "Achievements", value: stats.achievementsCount },
  ];

  const regDate = stats.registrationDate
    ? new Date(stats.registrationDate * 1000).toLocaleDateString()
    : "N/A";
  const lastActive = stats.lastActiveDate
    ? new Date(stats.lastActiveDate * 1000).toLocaleDateString()
    : "N/A";

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
                <span>Registered: {regDate}</span>
                <span>Last active: {lastActive}</span>
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
          <PlayerComparison stats={stats} turnstileToken={turnstileToken} />
        </div>
      </div>
    </main>
  );
}
