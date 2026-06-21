"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";
import FavoritesList from "@/components/FavoritesList";
import FavoritesCompare from "@/components/FavoritesCompare";
import StatCard from "@/components/StatCard";
import type { ParsedPlayerStats } from "@/types/tarkov";

interface FavStatsResponse {
  favorites: { aid: number; stats: ParsedPlayerStats | null }[];
}

export default function ProfilePage() {
  const { t } = useI18n();
  const { enabled, loading, favorites } = useFavorites();
  const [statsByAid, setStatsByAid] = useState<Map<number, ParsedPlayerStats | null>>(new Map());
  const [statsLoading, setStatsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statsError, setStatsError] = useState("");

  const loadStats = useCallback(async () => {
    setRefreshing(true);
    setStatsError("");
    try {
      const res = await fetch("/api/favorites/stats");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as FavStatsResponse;
      const map = new Map<number, ParsedPlayerStats | null>();
      for (const f of data.favorites) map.set(f.aid, f.stats);
      setStatsByAid(map);
    } catch {
      setStatsError(t("profile.loadError"));
    } finally {
      setRefreshing(false);
      setStatsLoading(false);
    }
  }, [t]);

  // Pull stats once the session resolves. Only the signed-in + has-pins case
  // needs an upstream round-trip; otherwise nothing renders the stats anyway.
  useEffect(() => {
    // Fetch-on-condition once the session resolves; re-fetching is manual.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (enabled && favorites.length > 0) loadStats();
    // Intentionally keyed on `enabled` only — re-fetching is manual ("refresh all").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Session still resolving.
  if (loading) {
    return (
      <main className="flex-1 px-4 py-8 max-w-3xl mx-auto w-full">
        <div className="h-8 w-40 skeleton rounded mb-6" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 skeleton rounded-lg" />
          ))}
        </div>
      </main>
    );
  }

  // Signed out.
  if (!enabled) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center px-4 gap-4 text-center">
        <h1 className="text-2xl font-bold text-[var(--accent)]">{t("profile.title")}</h1>
        <p className="text-sm text-gray-400 max-w-sm">{t("profile.signInPrompt")}</p>
        <a
          href="/api/auth/google"
          className="flex items-center gap-2 px-4 py-2 text-sm bg-[var(--card-bg)] border border-[var(--card-border)] rounded hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
        >
          {t("auth.signIn")}
        </a>
        <Link href="/" className="text-sm text-gray-500 hover:text-[var(--accent)]">
          {t("common.back")}
        </Link>
      </main>
    );
  }

  const main = favorites.find((f) => f.isMain);
  const mainStats = main ? statsByAid.get(main.aid) ?? null : null;

  return (
    <main className="flex-1 px-4 py-8 max-w-3xl mx-auto w-full space-y-8">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold text-[var(--accent)]">{t("profile.title")}</h1>
        <Link href="/" className="text-sm text-gray-500 hover:text-[var(--accent)]">
          {t("nav.searchById")}
        </Link>
      </div>

      {statsError && <p className="text-[var(--danger)] text-sm">{statsError}</p>}

      {favorites.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-400">{t("profile.empty")}</p>
          <p className="text-sm text-gray-600 mt-1">{t("profile.emptyHint")}</p>
          <Link href="/" className="inline-block mt-4 text-[var(--accent)] hover:underline">
            {t("common.back")}
          </Link>
        </div>
      ) : (
        <>
          {main && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm uppercase tracking-wider text-gray-500">
                  {t("profile.mainHeading")}
                </h2>
                <Link
                  href={`/player/${main.aid}`}
                  className="text-sm text-[var(--accent)] hover:underline"
                >
                  {t("profile.open")}
                </Link>
              </div>
              <div className="text-xl font-bold text-[var(--accent)]">
                {mainStats?.nickname || main.nickname || `#${main.aid}`}
              </div>
              {mainStats ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <StatCard label={t("player.hoursPlayed")} value={Math.round(mainStats.hoursPlayed).toLocaleString()} />
                  <StatCard label={t("player.level")} value={mainStats.level} />
                  <StatCard label={t("player.survivalRate")} value={String(mainStats.survivalRate)} suffix="%" />
                  <StatCard label={t("player.kdAll")} value={mainStats.kdRatio} />
                  <StatCard label={t("player.killsPerRaid")} value={mainStats.killsPerRaid} />
                  <StatCard label={t("player.totalKills")} value={mainStats.totalKills.toLocaleString()} />
                </div>
              ) : (
                <p className="text-sm text-gray-500">
                  {statsLoading ? t("common.loading") : t("profile.statsUnavailable")}
                </p>
              )}
            </section>
          )}

          <FavoritesList
            statsByAid={statsByAid}
            statsLoading={statsLoading}
            onRefreshAll={loadStats}
            refreshing={refreshing}
          />

          <section className="space-y-3">
            <div>
              <h2 className="text-sm uppercase tracking-wider text-gray-500">
                {t("profile.compareHeading")}
              </h2>
              <p className="text-xs text-gray-600 mt-1">{t("profile.compareHint")}</p>
            </div>
            <FavoritesCompare favorites={favorites} statsByAid={statsByAid} />
          </section>
        </>
      )}
    </main>
  );
}
