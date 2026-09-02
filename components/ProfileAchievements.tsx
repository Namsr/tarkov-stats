"use client";

import { useId, useMemo, useState } from "react";
import Image from "next/image";
import EarlyUnlocks from "@/components/EarlyUnlocks";
import ProfileCollapsible from "@/components/ProfileCollapsible";
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

type AchievementColumn = { key: AchievementSortKey; labelKey: string };

const PROFILE_COLUMNS: ReadonlyArray<AchievementColumn> = [
  { key: "alphabet", labelKey: "achievement.col.name" },
  { key: "percent", labelKey: "achievement.col.percent" },
  { key: "date", labelKey: "achievement.col.completed" },
  { key: "rarity", labelKey: "achievement.col.rarity" },
];
const AVERAGE_COLUMNS: ReadonlyArray<AchievementColumn> = [
  { key: "alphabet", labelKey: "achievement.col.name" },
  { key: "percent", labelKey: "achievement.col.percent" },
  { key: "hours", labelKey: "achievement.col.unlockTime" },
  { key: "rarity", labelKey: "achievement.col.rarity" },
];
const ACHIEVEMENT_PREVIEW_COUNT = 3;

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
      earlyHours: null,
      unlockHours: null,
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
    earlyHours: finiteOrNull(row.earlyHours),
    unlockHours: finiteOrNull(row.unlockHours),
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

function formatHours(value: number | null, locale: string, unit: string): string | null {
  return value == null || value <= 0
    ? null
    : `${value.toLocaleString(locale, { maximumFractionDigits: 0 })} ${unit}`;
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
    : key === "date" || key === "hours" ? "desc" : "asc";
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
  column: AchievementColumn;
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
  variant = "profile",
}: {
  items: readonly unknown[] | null | undefined;
  loading?: boolean;
  playerHours?: number;
  ownedIds?: readonly string[];
  mode: "regular" | "pve" | "seasonal";
  cycleId: string;
  variant?: "profile" | "average";
}) {
  const { t, lang } = useI18n();
  const [sortKey, setSortKey] = useState<AchievementSortKey>(variant === "average" ? "percent" : "date");
  const [direction, setDirection] = useState<AchievementSortDirection>("desc");
  const [expanded, setExpanded] = useState(false);
  const collapseId = `profile-achievements-${useId().replace(/:/g, "")}`;
  const columns = variant === "average" ? AVERAGE_COLUMNS : PROFILE_COLUMNS;
  const achievements = useMemo(
    () => (items ?? []).flatMap((item) => {
      const normalized = normalizeAchievement(item);
      if (!normalized || (variant === "average" && (normalized.owners ?? 0) <= 0)) return [];
      return [normalized];
    }),
    [items, variant],
  );
  const sorted = useMemo(
    () => sortProfileAchievements(achievements, sortKey, direction, lang),
    [achievements, direction, lang, sortKey],
  );
  const canCollapse = sorted.length > ACHIEVEMENT_PREVIEW_COUNT;
  const owned = ownedIds ?? achievements.map((achievement) => achievement.id);
  const changeSort = (key: AchievementSortKey) => {
    if (sortKey === key) {
      setDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setDirection(key === "date" || key === "hours" ? "desc" : "asc");
  };

  return (
    <div className="space-y-5">
      <section className="data-panel min-h-[240px] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-heading text-base">{t("profile.section.achievements")}</h2>
          <div className="achievement-mobile-sort" role="group" aria-label={t("achievement.sortLabel")}>
            {columns.map((column) => (
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
          <p className="text-sm text-[var(--muted)]">
            {t(variant === "average" ? "achv.empty" : "achievement.empty")}
          </p>
        ) : (
          <>
            <ProfileCollapsible
              id={collapseId}
              className="achievement-collapsible__content"
              expanded={!canCollapse || expanded}
            >
            <div className="achievement-table-wrap">
              <table className="achievement-table">
                <caption className="sr-only">
                  {t(variant === "average" ? "achievement.averageTableCaption" : "achievement.tableCaption")}
                </caption>
                <thead>
                  <tr>
                    {columns.filter((column) => column.key === "alphabet").map((column) => (
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
                    {columns.filter((column) => column.key !== "alphabet").map((column) => (
                      <th
                        key={column.key}
                        className={column.key === "percent" || column.key === "date" || column.key === "hours"
                          ? "achievement-table__number-header"
                          : undefined}
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
                  {sorted.map((achievement, index) => {
                    const name = localizedAchievementName(achievement, lang);
                    const description = localizedAchievementDescription(achievement, lang)?.trim() || null;
                    const completed = formatDate(achievement.unlockedAt, lang);
                    const unlockTime = formatHours(achievement.unlockHours, lang, t("unit.h"));
                    const rarity = rarityLabel(achievement, t);
                    return (
                      <tr
                        key={achievement.id}
                        aria-hidden={canCollapse && !expanded && index > ACHIEVEMENT_PREVIEW_COUNT ? true : undefined}
                        className={canCollapse && !expanded && index === ACHIEVEMENT_PREVIEW_COUNT
                          ? "profile-collapsible__preview-tail"
                          : undefined}
                      >
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
                          {variant === "average"
                            ? unlockTime ?? <span className="achievement-table__muted">{t("achievement.notAvailable")}</span>
                            : completed
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
              {sorted.map((achievement, index) => {
                const name = localizedAchievementName(achievement, lang);
                const description = localizedAchievementDescription(achievement, lang)?.trim() || null;
                const completed = formatDate(achievement.unlockedAt, lang);
                const unlockTime = formatHours(achievement.unlockHours, lang, t("unit.h"));
                const rarity = rarityLabel(achievement, t);
                return (
                  <article
                    key={achievement.id}
                    aria-hidden={canCollapse && !expanded && index > ACHIEVEMENT_PREVIEW_COUNT ? true : undefined}
                    className={`achievement-card ${canCollapse && !expanded && index === ACHIEVEMENT_PREVIEW_COUNT ? "profile-collapsible__preview-tail" : ""}`}
                    role="listitem"
                  >
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
                        <dt>{t(variant === "average" ? "achievement.col.unlockTime" : "achievement.col.completed")}</dt>
                        <dd>
                          {variant === "average"
                            ? unlockTime ?? t("achievement.notAvailable")
                            : completed ?? t("achievement.dateUnavailable")}
                        </dd>
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
            </ProfileCollapsible>
            {canCollapse && (
              <button
                type="button"
                className="profile-collapsible__toggle achievement-collapsible__toggle"
                aria-expanded={expanded}
                aria-controls={collapseId}
                onClick={() => setExpanded((value) => !value)}
              >
                <span>{t(expanded ? "achievement.collapse" : "achievement.expand")}</span>
                <span aria-hidden="true">{expanded ? "↑" : "↓"}</span>
              </button>
            )}
          </>
        )}
      </section>
      {variant === "profile" && (
        <EarlyUnlocks playerHours={playerHours} ownedIds={owned} mode={mode} cycleId={cycleId} />
      )}
    </div>
  );
}
