"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";
import FavoritesList from "@/components/FavoritesList";
import FavoritesCompare from "@/components/FavoritesCompare";
import StatCard from "@/components/StatCard";
import { isReload } from "@/lib/is-reload";
import type { ParsedPlayerStats } from "@/types/tarkov";
import { favoriteHref, favoriteKey } from "@/lib/favorites/identity";

interface FavStatsResponse {
  favorites: {
    mode: "regular" | "pve" | "arena" | "seasonal";
    cycleId: string;
    aid: number;
    stats: ParsedPlayerStats | null;
  }[];
}

export default function ProfilePage() {
  const { t } = useI18n();
  const { enabled, loading, favorites } = useFavorites();
  const [statsByFavorite, setStatsByFavorite] = useState<Map<string, ParsedPlayerStats | null>>(new Map());
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState("");

  // force=true (страница открыта через перезагрузку) обходит 5-мин кэш upstream,
  // чтобы подтянуть то, что игрок только что обновил на tarkov.dev.
  const loadStats = useCallback(async (force = false) => {
    setStatsError("");
    try {
      const res = await fetch(`/api/favorites/stats${force ? "?refresh=1" : ""}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as FavStatsResponse;
      const map = new Map<string, ParsedPlayerStats | null>();
      for (const favorite of data.favorites) map.set(favoriteKey(favorite), favorite.stats);
      setStatsByFavorite(map);
    } catch {
      setStatsError(t("profile.loadError"));
    } finally {
      setStatsLoading(false);
    }
  }, [t]);

  // Pull stats once the session resolves. Only the signed-in + has-pins case
  // needs an upstream round-trip; otherwise nothing renders the stats anyway.
  useEffect(() => {
    // Fetch-on-condition once the session resolves. On a full page reload (F5) we
    // force-bypass the cache so favorites reflect a just-refreshed tarkov.dev cache.
    if (enabled && favorites.length > 0) loadStats(isReload());
    // Intentionally keyed on `enabled` only — otherwise re-fetching is via reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Session still resolving.
  if (loading) {
    return (
      <main className="page-frame max-w-3xl">
        <div className="h-8 w-40 skeleton rounded mb-6" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 skeleton rounded-xl" />
          ))}
        </div>
      </main>
    );
  }

  // Signed out.
  if (!enabled) {
    return (
      <main className="home-hero">
        <div className="home-command text-center">
        <p className="page-kicker">{t("nav.profile")}</p>
        <h1 className="home-command__title text-[clamp(2.7rem,10vw,5.4rem)]">{t("profile.title")}</h1>
        <p className="home-command__description">{t("profile.signInPrompt")}</p>
        <a
          href="/api/auth/google"
          className="tactical-button mt-7"
        >
          {t("auth.signIn")}
        </a>
        <Link href="/" className="block mt-5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
          {t("common.back")}
        </Link>
        </div>
      </main>
    );
  }

  const main = favorites.find((f) => f.isMain);
  const mainStats = main ? statsByFavorite.get(favoriteKey(main)) ?? null : null;

  return (
    <main className="page-frame max-w-5xl space-y-10">
      <div>
        <Link
          href="/"
          className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors mb-7 inline-block"
        >
          {t("common.back")}
        </Link>
        <p className="page-kicker">{t("nav.profile")}</p>
        <h1 className="page-title">{t("profile.title")}</h1>
      </div>

      {statsError && <p className="text-[var(--danger)] text-sm">{statsError}</p>}

      {favorites.length === 0 ? (
        <div className="surface text-center py-14 px-5">
          <p className="text-[var(--muted-strong)]">{t("profile.empty")}</p>
          <p className="text-sm text-[var(--muted)] mt-2">{t("profile.emptyHint")}</p>
          <Link href="/" className="inline-block mt-6 text-[var(--accent)] hover:underline underline-offset-4">
            {t("common.back")}
          </Link>
        </div>
      ) : (
        <>
          {main && (
            <section className="surface p-5 sm:p-6 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="section-heading text-base">
                  {t("profile.mainHeading")}
                </h2>
                <Link
                  href={favoriteHref(main)}
                  className="ghost-button !min-h-9 !px-3 !py-2 text-xs text-[var(--accent)]"
                >
                  {t("profile.open")}
                </Link>
              </div>
              <div className="font-[var(--heading-font)] text-3xl font-extrabold tracking-wide text-[var(--foreground)]">
                {mainStats?.nickname || main.nickname || `#${main.aid}`}
              </div>
              {mainStats ? (
                <div className="detail-grid detail-grid--compact">
                  <StatCard label={t("player.hoursPlayed")} value={Math.round(mainStats.hoursPlayed).toLocaleString()} />
                  <StatCard label={t("player.level")} value={mainStats.level} />
                  <StatCard label={t("player.survivalRate")} value={String(mainStats.survivalRate)} suffix="%" />
                  <StatCard label={t("player.kdAll")} value={mainStats.kdRatio} />
                  <StatCard label={t("player.killsPerRaid")} value={mainStats.killsPerRaid} />
                  <StatCard label={t("player.totalKills")} value={mainStats.totalKills.toLocaleString()} />
                </div>
              ) : (
                <p className="text-sm text-[var(--muted)]">
                  {statsLoading ? t("common.loading") : t("profile.statsUnavailable")}
                </p>
              )}
            </section>
          )}

          <FavoritesList statsByFavorite={statsByFavorite} statsLoading={statsLoading} />

          <section className="data-panel p-5 sm:p-6 space-y-4">
            <div>
              <h2 className="section-heading text-base">
                {t("profile.compareHeading")}
              </h2>
              <p className="text-sm text-[var(--muted)] mt-2">{t("profile.compareHint")}</p>
            </div>
            <FavoritesCompare favorites={favorites} statsByFavorite={statsByFavorite} />
          </section>
        </>
      )}
    </main>
  );
}
