"use client";

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { SeasonalAchievementView } from "@/types/profile-view";

const RARITY_ORDER = ["legendary", "epic", "rare", "uncommon", "common"];

function rarityKey(value: string): "common" | "rare" | "legendary" {
  const normalized = value.toLowerCase();
  return normalized === "rare" || normalized === "legendary" ? normalized : "common";
}

function formatDate(value: number | null, locale: string): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Moscow" }).format(value);
}

export default function SeasonalAchievements({
  achievements,
  loading = false,
}: {
  achievements: SeasonalAchievementView[] | null;
  loading?: boolean;
}) {
  const { t, lang } = useI18n();
  const sorted = useMemo(() => {
    if (!achievements) return [];
    return [...achievements].sort((a, b) => {
      const rarityA = RARITY_ORDER.indexOf(a.rarity.toLowerCase());
      const rarityB = RARITY_ORDER.indexOf(b.rarity.toLowerCase());
      const rarity = (rarityA < 0 ? RARITY_ORDER.length : rarityA) - (rarityB < 0 ? RARITY_ORDER.length : rarityB);
      if (rarity !== 0) return rarity;
      const prevalenceA = a.percentage == null ? Number.POSITIVE_INFINITY : a.percentage;
      const prevalenceB = b.percentage == null ? Number.POSITIVE_INFINITY : b.percentage;
      if (prevalenceA !== prevalenceB) return prevalenceA - prevalenceB;
      return (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0);
    });
  }, [achievements]);

  return (
    <div className="data-panel min-h-[240px] p-5">
      <h2 className="section-heading text-base mb-2">{t("profile.section.seasonalAchievements")}</h2>
      <p className="text-sm text-[var(--muted)] mb-4">{t("achievement.seasonalDescription")}</p>

      {loading ? (
        <div className="space-y-2" role="status" aria-label={t("common.loading")}>
          {Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-16 skeleton rounded" />)}
        </div>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">{t("achievement.seasonalEmpty")}</p>
      ) : (
        <div className="space-y-2">
          {sorted.map((achievement) => {
            const date = formatDate(achievement.unlockedAt, lang);
            const percentage = achievement.percentage == null
              ? t("achievement.percentageUnavailable")
              : `${achievement.percentage.toLocaleString(lang, { maximumFractionDigits: 2 })}%`;
            return (
              <div key={achievement.id} className="border-b border-[var(--card-border)] last:border-0 py-2.5">
                <div className="flex items-start justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-[var(--muted-strong)]">{lang === "ru" && achievement.nameRu ? achievement.nameRu : achievement.name}</span>
                  <span className="shrink-0 text-xs text-[var(--accent)]">
                    {t("achievement.rarity." + rarityKey(achievement.rarity))}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
                  <span>{t("achievement.unlockedAt", { date: date ?? t("achievement.dateUnavailable") })}</span>
                  <span>{t("achievement.owners", {
                    owners: achievement.owners == null ? t("common.notAvailable") : achievement.owners.toLocaleString(lang),
                    eligible: achievement.eligibleN == null ? t("common.notAvailable") : achievement.eligibleN.toLocaleString(lang),
                  })}</span>
                  <span>{t("achievement.percentage", { value: percentage })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
