"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import EarlyUnlocks from "@/components/EarlyUnlocks";
import { useI18n } from "@/lib/i18n/context";
import {
  achievementRarityKey,
  localizedAchievementDescription,
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
  descriptionEn?: unknown;
  image?: unknown;
  icon?: unknown;
  samplePercentage?: unknown;
  samplePct?: unknown;
  sampleOwners?: unknown;
  sampleEligibleN?: unknown;
  officialPct?: unknown;
  category?: unknown;
  earned?: unknown;
  owned?: unknown;
};

const SORTABLE_COLUMNS: ReadonlyArray<{ key: AchievementSortKey; labelKey: string }> = [
  { key: "alphabet", labelKey: "achievement.col.name" },
  { key: "percent", labelKey: "achievement.col.percent" },
  { key: "date", labelKey: "achievement.col.completed" },
  { key: "rarity", labelKey: "achievement.col.rarity" },
];

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
      description: null,
      descriptionRu: null,
      imageUrl: null,
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
  const imageCandidate = row.imageUrl ?? row.image ?? row.icon;
  return {
    id,
    unlockedAt: timestampOrNull(row.unlockedAt),
    name: typeof row.name === "string" ? row.name : typeof row.nameEn === "string" ? row.nameEn : null,
    nameRu: typeof row.nameRu === "string" ? row.nameRu : null,
    description: typeof row.description === "string"
      ? row.description
      : typeof row.descriptionEn === "string" ? row.descriptionEn : null,
    descriptionRu: typeof row.descriptionRu === "string" ? row.descriptionRu : null,
    imageUrl: typeof imageCandidate === "string" && imageCandidate.trim() ? imageCandidate : null,
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

function formatCount(value: number | null, locale: string): string | null {
  return value == null ? null : value.toLocaleString(locale, { maximumFractionDigits: 0 });
}

function formatDate(value: number | null, locale: string): string | null {
  return value == null
    ? null
    : new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Moscow",
    }).format(value);
}

function sortAriaValue(
  active: boolean,
  direction: AchievementSortDirection,
): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return direction === "asc" ? "ascending" : "descending";
}

function nextDirectionLabel(
  active: boolean,
  key: AchievementSortKey,
  direction: AchievementSortDirection,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const nextDirection = active
    ? direction === "asc" ? "desc" : "asc"
    : key === "date" ? "desc" : "asc";
  return t(nextDirection === "asc" ? "achievement.sort.directionAsc" : "achievement.sort.directionDesc");
}

function AchievementIcon({ imageUrl }: { imageUrl: string | null }) {
  return imageUrl ? (
    <Image
      className="achievement-table__icon"
      src={imageUrl}
      width={56}
      height={56}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="achievement-table__icon achievement-table__icon--empty" aria-hidden="true" />
  );
}

function AchievementPercentage({
  achievement,
  locale,
  t,
}: {
  achievement: ProfileAchievementItem;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const sample = formatPercentage(achievement.percentage, locale);
  const official = formatPercentage(achievement.officialPercentage, locale);
  const owners = formatCount(achievement.owners, locale);
  const eligible = formatCount(achievement.eligibleN, locale);
  const sampleWithCounts = sample && owners != null && eligible != null
    ? t("achievement.samplePrimary", { value: sample, owners, eligible })
    : sample ? t("achievement.sampleValue", { value: sample }) : null;
  const primary = sampleWithCounts
    ?? (official ? t("achievement.bsgPrimary", { value: official }) : t("achievement.notAvailable"));

  return (
    <div className="achievement-table__percent">
      <strong>{primary}</strong>
      {sample && official ? <small>{t("achievement.bsgLine", { value: official })}</small> : null}
    </div>
  );
}

function rarityLabel(achievement: ProfileAchievementItem, t: (key: string) => string): string {
  const raw = achievement.rarity ?? achievement.officialCategory;
  if (!raw) return t("achievement.notAvailable");
  const key = achievementRarityKey(raw);
  if (!key) return raw;
  const translatedKey = `achievement.rarity.${key}`;
  const translated = t(translatedKey);
  return translated === translatedKey ? raw : translated;
}

function SortButton({
  column,
  active,
  direction,
  onChange,
  t,
}: {
  column: (typeof SORTABLE_COLUMNS)[number];
  active: boolean;
  direction: AchievementSortDirection;
  onChange: (key: AchievementSortKey) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const label = t(column.labelKey);
  return (
    <button
      type="button"
      className={`achievement-table__sort ${active ? "is-active" : ""}`}
      aria-pressed={active}
      aria-label={t("achievement.sortBy", {
        column: label,
        direction: nextDirectionLabel(active, column.key, direction, t),
      })}
      onClick={() => onChange(column.key)}
    >
      <span>{label}</span>
      {active ? <span aria-hidden="true" className="achievement-table__sort-arrow">{direction === "asc" ? "↑" : "↓"}</span> : null}
    </button>
  );
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
          <div className="achievement-mobile-sort" role="group" aria-label={t("achievement.sortLabel")}>
            {SORTABLE_COLUMNS.map((column) => (
              <SortButton
                key={column.key}
                column={column}
                active={sortKey === column.key}
                direction={direction}
                onChange={changeSort}
                t={t}
              />
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
          <>
            <div className="achievement-table-wrap">
              <table className="achievement-table">
                <caption className="sr-only">{t("achievement.tableCaption")}</caption>
                <thead>
                  <tr>
                    {SORTABLE_COLUMNS.filter((column) => column.key === "alphabet").map((column) => (
                      <th key={column.key} scope="col" aria-sort={sortAriaValue(sortKey === column.key, direction)}>
                        <SortButton
                          column={column}
                          active={sortKey === column.key}
                          direction={direction}
                          onChange={changeSort}
                          t={t}
                        />
                      </th>
                    ))}
                    <th scope="col">{t("achievement.col.description")}</th>
                    {SORTABLE_COLUMNS.filter((column) => column.key !== "alphabet").map((column) => (
                      <th
                        key={column.key}
                        className={column.key === "percent" || column.key === "date" ? "achievement-table__number-header" : undefined}
                        scope="col"
                        aria-sort={sortAriaValue(sortKey === column.key, direction)}
                      >
                        <SortButton
                          column={column}
                          active={sortKey === column.key}
                          direction={direction}
                          onChange={changeSort}
                          t={t}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((achievement) => {
                    const name = localizedAchievementName(achievement, lang);
                    const description = localizedAchievementDescription(achievement, lang)?.trim() || null;
                    const completed = formatDate(achievement.unlockedAt, lang);
                    const rarity = rarityLabel(achievement, t);
                    return (
                      <tr key={achievement.id}>
                        <th scope="row" className="achievement-table__name-cell">
                          <div className="achievement-table__name">
                            <AchievementIcon imageUrl={achievement.imageUrl} />
                            <span title={name}>{name}</span>
                          </div>
                        </th>
                        <td className="achievement-table__description" title={description ?? undefined}>
                          {description ?? <span className="achievement-table__muted">{t("achievement.descriptionUnavailable")}</span>}
                        </td>
                        <td className="achievement-table__number"><AchievementPercentage achievement={achievement} locale={lang} t={t} /></td>
                        <td className="achievement-table__number achievement-table__completed">
                          {completed
                            ? <time dateTime={achievement.unlockedAt == null ? undefined : new Date(achievement.unlockedAt).toISOString()}>{completed}</time>
                            : <span className="achievement-table__muted">{t("achievement.dateUnavailable")}</span>}
                        </td>
                        <td className="achievement-table__rarity">{rarity}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="achievement-cards" role="list">
              {sorted.map((achievement) => {
                const name = localizedAchievementName(achievement, lang);
                const description = localizedAchievementDescription(achievement, lang)?.trim() || null;
                const completed = formatDate(achievement.unlockedAt, lang);
                const rarity = rarityLabel(achievement, t);
                return (
                  <article key={achievement.id} className="achievement-card" role="listitem">
                    <div className="achievement-card__heading">
                      <AchievementIcon imageUrl={achievement.imageUrl} />
                      <div className="min-w-0">
                        <h3 className="achievement-card__name" title={name}>{name}</h3>
                        <p className="achievement-card__description">
                          {description ?? <span className="achievement-table__muted">{t("achievement.descriptionUnavailable")}</span>}
                        </p>
                      </div>
                    </div>
                    <dl className="achievement-card__meta">
                      <div>
                        <dt>{t("achievement.col.percent")}</dt>
                        <dd><AchievementPercentage achievement={achievement} locale={lang} t={t} /></dd>
                      </div>
                      <div>
                        <dt>{t("achievement.col.completed")}</dt>
                        <dd>{completed ?? t("achievement.dateUnavailable")}</dd>
                      </div>
                      <div>
                        <dt>{t("achievement.col.rarity")}</dt>
                        <dd>{rarity}</dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
      <EarlyUnlocks playerHours={playerHours} ownedIds={owned} mode={mode} cycleId={cycleId} />
    </div>
  );
}
