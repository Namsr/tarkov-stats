"use client";

import { useMemo, useState } from "react";
import EarlyUnlocks from "@/components/EarlyUnlocks";
import { useI18n } from "@/lib/i18n/context";
import {
  localizedAchievementName,
  sortProfileAchievements,
  type AchievementSortDirection,
  type AchievementSortKey,
  type ProfileAchievementItem,
} from "@/lib/profile-achievements";

type ProfileAchievementInput = Partial<ProfileAchievementItem> & {
  id?: unknown;
  achId?: unknown;
  nameEn?: unknown;
  samplePercentage?: unknown;
  samplePct?: unknown;
  sampleOwners?: unknown;
  sampleEligibleN?: unknown;
  officialPct?: unknown;
  category?: unknown;
  earned?: unknown;
  owned?: unknown;
};

const SORT_LABEL_KEYS: Record<AchievementSortKey, string> = {
  date: "achievement.sort.date",
  alphabet: "achievement.sort.alphabet",
  rarity: "achievement.sort.rarity",
};

function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampOrNull(value: unknown): number | null {
  const number = finiteOrNull(value);
  if (number == null || number <= 0) return null;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function normalizeAchievement(value: unknown): ProfileAchievementItem | null {
  if (typeof value === "string") {
    return {
      id: value,
      unlockedAt: null,
      name: null,
      nameRu: null,
      rarity: null,
      owners: null,
      eligibleN: null,
      percentage: null,
      officialPercentage: null,
      officialCategory: null,
    };
  }
  if (!value || typeof value !== "object") return null;
  const row = value as ProfileAchievementInput;
  if (row.earned === false || row.owned === false) return null;
  const id = typeof row.id === "string" ? row.id : typeof row.achId === "string" ? row.achId : null;
  if (!id) return null;
  const percentage = finiteOrNull(row.percentage ?? row.samplePercentage ?? row.samplePct);
  return {
    id,
    unlockedAt: timestampOrNull(row.unlockedAt),
    name: typeof row.name === "string" ? row.name : typeof row.nameEn === "string" ? row.nameEn : null,
    nameRu: typeof row.nameRu === "string" ? row.nameRu : null,
    rarity: typeof row.rarity === "string" ? row.rarity : null,
    owners: finiteOrNull(row.owners ?? row.sampleOwners),
    eligibleN: finiteOrNull(row.eligibleN ?? row.sampleEligibleN),
    percentage,
    officialPercentage: finiteOrNull(row.officialPercentage ?? row.officialPct),
    officialCategory: typeof row.officialCategory === "string"
      ? row.officialCategory
      : typeof row.category === "string" ? row.category : null,
  };
}

function formatPercentage(value: number | null, locale: string): string | null {
  return value == null ? null : `${value.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
}

function formatDate(value: number | null, locale: string): string | null {
  return value == null
    ? null
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Moscow" }).format(value);
}

function rarityKey(value: string | null): string {
  return (value ?? "common").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "common";
}

export default function ProfileAchievements({
  items,
  loading = false,
  playerHours = 0,
  ownedIds,
  mode,
  cycleId,
}: {
  items: readonly unknown[] | null | undefined;
  loading?: boolean;
  playerHours?: number;
  ownedIds?: readonly string[];
  mode: "regular" | "seasonal";
  cycleId: string;
}) {
  const { t, lang } = useI18n();
  const [sortKey, setSortKey] = useState<AchievementSortKey>("date");
  const [direction, setDirection] = useState<AchievementSortDirection>("desc");
  const achievements = useMemo(
    () => (items ?? []).flatMap((item) => {
      const normalized = normalizeAchievement(item);
      return normalized ? [normalized] : [];
    }),
    [items],
  );
  const sorted = useMemo(
    () => sortProfileAchievements(achievements, sortKey, direction, lang),
    [achievements, direction, lang, sortKey],
  );
  const owned = ownedIds ?? achievements.map((achievement) => achievement.id);
  const changeSort = (key: AchievementSortKey) => {
    if (sortKey === key) {
      setDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setDirection(key === "date" ? "desc" : "asc");
  };

  return (
    <div className="space-y-5">
      <section className="data-panel min-h-[240px] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-heading text-base">{t("profile.section.achievements")}</h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("achievement.sortLabel")}>
            {(["date", "alphabet", "rarity"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={`ghost-button px-3 py-1.5 text-xs ${sortKey === key ? "is-active" : ""}`}
                aria-pressed={sortKey === key}
                onClick={() => changeSort(key)}
              >
                {t(SORT_LABEL_KEYS[key])}
                {sortKey === key && <span aria-hidden="true" className="ml-1">{direction === "asc" ? "↑" : "↓"}</span>}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="space-y-2" role="status" aria-label={t("common.loading")}>
            {Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-16 skeleton rounded" />)}
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">{t("achievement.empty")}</p>
        ) : (
          <div className="space-y-2">
            {sorted.map((achievement) => {
              const date = formatDate(achievement.unlockedAt, lang);
              const samplePercentage = formatPercentage(achievement.percentage, lang);
              const officialPercentage = formatPercentage(achievement.officialPercentage, lang);
              const sampleValue = samplePercentage ?? t("achievement.notAvailable");
              const owners = achievement.owners == null ? t("achievement.notAvailable") : achievement.owners.toLocaleString(lang);
              const eligible = achievement.eligibleN == null ? t("achievement.notAvailable") : achievement.eligibleN.toLocaleString(lang);
              const officialValue = officialPercentage
                ?? (achievement.officialCategory ? t("achievement.category." + rarityKey(achievement.officialCategory)) : t("achievement.notAvailable"));
              return (
                <article key={achievement.id} className="border-b border-[var(--card-border)] last:border-0 py-2.5">
                  <div className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-[var(--muted-strong)]">{localizedAchievementName(achievement, lang)}</span>
                    <span className="shrink-0 text-xs text-[var(--accent)]">{t("achievement.rarity." + rarityKey(achievement.rarity))}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted)]">
                    <span>{t("achievement.unlockedAt", { date: date ?? t("achievement.dateUnavailable") })}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted)]">
                    <span>{t("achievement.sampleLine", { owners, eligible, value: sampleValue })}</span>
                  </div>
                  <div className="text-[11px] text-[var(--muted)]">
                    <span>{t("achievement.officialLine", { value: officialValue })}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <EarlyUnlocks playerHours={playerHours} ownedIds={owned} mode={mode} cycleId={cycleId} />
    </div>
  );
}
