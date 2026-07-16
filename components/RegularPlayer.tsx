"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { PlayerProfile, ParsedPlayerStats, SkillEntry } from "@/types/tarkov";
import StatCard from "@/components/StatCard";
import PlayerRadarComparison from "@/components/PlayerRadarComparison";
import CheaterScore from "@/components/CheaterScore";
import EarlyUnlocks from "@/components/EarlyUnlocks";
import FavoriteButton from "@/components/FavoriteButton";
import RefreshButton from "@/components/RefreshButton";
import { useI18n } from "@/lib/i18n/context";
import { isReload } from "@/lib/is-reload";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import type { CrossSectionMode } from "@/lib/db";

const PROFILE_STALE_MS = 14 * 24 * 60 * 60 * 1000;

interface Props {
  params: Promise<{ aid: string }>;
  searchParams: Promise<{ radarDemo?: string | string[] }>;
}

export default function RegularPlayer({
  params,
  searchParams,
  mode = "regular",
}: Props & { mode?: CrossSectionMode }) {
  const { t } = useI18n();
  const { aid } = use(params);
  const query = use(searchParams);
  const radarDemoParam = Array.isArray(query.radarDemo) ? query.radarDemo[0] : query.radarDemo;
  const radarDemo = process.env.NODE_ENV === "development" && radarDemoParam === "1";
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [stats, setStats] = useState<ParsedPlayerStats | null>(null);
  const [achievementIds, setAchievementIds] = useState<string[]>([]);
  const [profileUpdatedAt, setProfileUpdatedAt] = useState<number | null>(null);
  const [profileIsStale, setProfileIsStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    // Reset the route-level request state whenever the account changes.
    setLoading(true);
    setError("");
    setProfileUpdatedAt(null);
    setProfileIsStale(false);

    // На перезагрузке (F5) обходим 5-мин кэш — «обновил на tarkov.dev → F5 → свежее».
    const requestParams = new URLSearchParams({ aid, mode });
    if (isReload()) requestParams.set("refresh", "1");
    fetch(`/api/player/profile?${requestParams}`)
      .then(async (res) => {
        const data = (await res.json()) as {
          error?: string;
          profile?: PlayerProfile;
          stats?: ParsedPlayerStats;
          achievementIds?: string[];
          profileUpdatedAt?: number | null;
        };
        if (!res.ok || !data.stats) {
          throw new Error(data.error ?? t("player.loadError"));
        }
        return { ...data, stats: data.stats };
      })
      .then((data) => {
        if (cancelled) return;
        setProfile(data.profile ?? null);
        setStats(data.stats);
        setAchievementIds(
          data.achievementIds ?? (data.profile?.achievements ? Object.keys(data.profile.achievements) : []),
        );
        const updatedAt = data.profileUpdatedAt ?? null;
        setProfileUpdatedAt(updatedAt);
        setProfileIsStale(updatedAt !== null && Date.now() - updatedAt > PROFILE_STALE_MS);
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
  }, [aid, mode, t]);

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

  if (error || !stats) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center px-4 gap-4">
        <ProfileModeSwitch current={mode} page="player" aid={Number(aid)} />
        <p className="text-[var(--danger)] text-lg text-center max-w-md">
          {error || t("player.unknownError")}
        </p>
        <Link href="/" className="text-[var(--accent)] hover:underline">
          {t("common.back")}
        </Link>
      </main>
    );
  }

  const arena = stats.arena;
  const coreStats: { label: string; value: string | number; suffix?: string }[] =
    mode === "arena"
      ? [
          { label: t("player.hoursPlayed"), value: stats.hoursPlayed },
          { label: t("arena.totalKills"), value: arena?.totalKills.toLocaleString() ?? "—" },
          { label: t("arena.totalDeaths"), value: arena?.totalDeaths.toLocaleString() ?? "—" },
          { label: t("arena.kdRatio"), value: arena?.kdRatio ?? "—" },
        ]
      : [
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

  const skills: SkillEntry[] = profile?.skills?.Common ?? [];
  const lastPlayedAt = Number(stats.lastPlayedAt) || null;
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  });
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
            {mode !== "arena" && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--muted)] mt-3">
                <span>{t("player.sideLabel", { side: stats.side })}</span>
                {stats.prestige > 0 && <span>{t("player.prestigeLabel", { n: stats.prestige })}</span>}
              </div>
            )}
            {profileUpdatedAt !== null && (
              <p className="mt-2 text-sm text-[var(--muted)]">
                {t("player.profileUpdated", {
                  date: dateTimeFormatter.format(profileUpdatedAt),
                })}
              </p>
            )}
            {lastPlayedAt !== null && (
              <p className="mt-2 text-sm text-[var(--muted)]">
                {t("player.lastPlayed", { date: dateTimeFormatter.format(lastPlayedAt) })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex flex-wrap items-start gap-2">
              <div className="flex max-w-56 flex-col items-start gap-1">
                <RefreshButton aid={Number(aid)} mode={mode} stale={profileIsStale} />
                {profileIsStale && (
                  <p className="text-xs font-medium leading-snug text-[var(--danger)]">
                    {t("player.refreshStaleMessage")}
                  </p>
                )}
              </div>
              <FavoriteButton
                aid={Number(aid)}
                nickname={stats.nickname}
                identity={{ mode, cycleId: "persistent" }}
              />
            </div>
            <ProfileModeSwitch current={mode} page="player" aid={Number(aid)} />
          </div>
        </div>

        <div className="detail-grid mt-7">
          {coreStats.map((item) => (
            <StatCard key={item.label} {...item} />
          ))}
        </div>
      </section>

      {mode === "arena" ? (
        <div className="mt-5 space-y-5">
          <section>
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

          <section>
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
          <div className="mt-5 grid gap-5 lg:grid-cols-2 lg:items-start">
        <PlayerRadarComparison aid={Number(aid)} stats={stats} mode={mode} demo={radarDemo} />
        <CheaterScore stats={stats} ownedAchievementIds={achievementIds} mode={mode} />
      </div>

          <div className="mt-5 space-y-5">
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
        <div className="page-grid mt-5">
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
