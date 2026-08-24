"use client";

import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import ProfileCollapsible from "@/components/ProfileCollapsible";
import {
  displayedWeaponMasteryProgress,
  sortWeaponMastery,
  type ProfileWeaponMastery,
  type WeaponMasterySortDirection,
  type WeaponMasterySortKey,
} from "@/lib/profile-mastery";

type MasteryInput = Partial<ProfileWeaponMastery> & {
  id?: unknown;
  weapon?: unknown;
  progress?: unknown;
  level?: unknown;
};

const SORTABLE_COLUMNS: ReadonlyArray<{ key: WeaponMasterySortKey; labelKey: string }> = [
  { key: "weapon", labelKey: "mastering.col.weapon" },
  { key: "progress", labelKey: "mastering.col.progress" },
];
const MASTERY_PREVIEW_COUNT = 5;
const ZERO_PREVIEW_COUNT = 1;

function normalizeMastery(value: unknown): ProfileWeaponMastery | null {
  if (!value || typeof value !== "object") return null;
  const row = value as MasteryInput;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const weapon = typeof row.weapon === "string" ? row.weapon.trim() : "";
  const progress = Number(row.progress);
  const level = Number(row.level);
  if (!id || !weapon || !Number.isFinite(progress) || progress < 0 ||
    !Number.isInteger(level) || level < 1 || level > 3) return null;
  return { id, weapon, progress, level: level as 1 | 2 | 3 };
}

export function hasVisibleMastery(items: readonly unknown[] | null | undefined): boolean {
  return (items ?? []).some((item) => normalizeMastery(item) !== null);
}

function ariaSortValue(active: boolean, direction: WeaponMasterySortDirection): "ascending" | "descending" | "none" {
  return active ? direction === "asc" ? "ascending" : "descending" : "none";
}

function nextDirectionLabel(
  active: boolean,
  key: WeaponMasterySortKey,
  direction: WeaponMasterySortDirection,
  t: (key: string) => string,
): string {
  const next = active ? direction === "asc" ? "desc" : "asc" : key === "progress" ? "desc" : "asc";
  return t(next === "asc" ? "mastering.sort.directionAsc" : "mastering.sort.directionDesc");
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
  direction: WeaponMasterySortDirection;
  onChange: (key: WeaponMasterySortKey) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const label = t(column.labelKey);
  return (
    <button
      type="button"
      className={`mastering-table__sort ${active ? "is-active" : ""}`}
      aria-pressed={active}
      aria-label={t("mastering.sortBy", {
        column: label,
        direction: nextDirectionLabel(active, column.key, direction, t),
      })}
      onClick={() => onChange(column.key)}
    >
      <span>{label}</span>
      {active ? <span aria-hidden="true" className="mastering-table__sort-arrow">{direction === "asc" ? "↑" : "↓"}</span> : null}
    </button>
  );
}

function progressLabel(progress: number, level: 1 | 2 | 3, locale: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  return t("mastering.progressValue", {
    progress: displayedWeaponMasteryProgress(progress).toLocaleString(locale, { maximumFractionDigits: 0 }),
    level,
  });
}

function MasteryList({
  rows,
  header,
  previewCount,
  collapsed = false,
  locale,
  t,
}: {
  rows: readonly ProfileWeaponMastery[];
  header?: ReactNode;
  previewCount?: number;
  collapsed?: boolean;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const tableHeader = header ?? (
    <tr>
      <th scope="col">{t("mastering.col.weapon")}</th>
      <th scope="col" className="mastering-table__number-header">{t("mastering.col.progress")}</th>
    </tr>
  );
  return (
    <>
      <div className="mastering-table-wrap">
        <table className="mastering-table">
          <caption className="sr-only">{t("mastering.tableCaption")}</caption>
          <thead>{tableHeader}</thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.id}
                aria-hidden={collapsed && previewCount !== undefined && index > previewCount ? true : undefined}
                className={collapsed && previewCount !== undefined && index === previewCount
                  ? "profile-collapsible__preview-tail"
                  : undefined}
              >
                <th scope="row">{row.weapon}</th>
                <td className="mastering-table__number">{progressLabel(row.progress, row.level, locale, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mastering-cards" role="list">
        {rows.map((row, index) => (
          <article
            key={row.id}
            aria-hidden={collapsed && previewCount !== undefined && index > previewCount ? true : undefined}
            className={`mastering-card ${collapsed && previewCount !== undefined && index === previewCount ? "profile-collapsible__preview-tail" : ""}`}
            role="listitem"
          >
            <h3>{row.weapon}</h3>
            <dl>
              <div>
                <dt>{t("mastering.col.progress")}</dt>
                <dd>{progressLabel(row.progress, row.level, locale, t)}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}

export default function ProfileMastering({ items }: { items: readonly unknown[] | null | undefined }) {
  const { t, lang } = useI18n();
  const [sortKey, setSortKey] = useState<WeaponMasterySortKey>("progress");
  const [direction, setDirection] = useState<WeaponMasterySortDirection>("desc");
  const [positiveExpanded, setPositiveExpanded] = useState(false);
  const [zeroExpanded, setZeroExpanded] = useState(false);
  const collapsePrefix = useId().replace(/:/g, "");
  const normalized = useMemo(
    () => (items ?? []).flatMap((item) => {
      const row = normalizeMastery(item);
      return row ? [row] : [];
    }),
    [items],
  );
  const sorted = useMemo(
    () => sortWeaponMastery(normalized, sortKey, direction, lang),
    [direction, lang, normalized, sortKey],
  );
  if (sorted.length === 0) return null;

  const positiveRows = sorted.filter((row) => displayedWeaponMasteryProgress(row.progress) > 0);
  const zeroRows = sorted.filter((row) => displayedWeaponMasteryProgress(row.progress) === 0);
  const positiveCanCollapse = positiveRows.length > MASTERY_PREVIEW_COUNT;
  const zeroCanCollapse = zeroRows.length > ZERO_PREVIEW_COUNT;
  const showZeroTail = !positiveCanCollapse || positiveExpanded;
  const positivePanelId = `profile-mastering-positive-${collapsePrefix}`;
  const zeroPanelId = `profile-mastering-zero-${collapsePrefix}`;

  const changeSort = (key: WeaponMasterySortKey) => {
    if (sortKey === key) {
      setDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setDirection(key === "progress" ? "desc" : "asc");
  };
  const togglePositive = () => {
    if (positiveExpanded) setZeroExpanded(false);
    setPositiveExpanded((value) => !value);
  };

  return (
    <div className="data-panel min-h-[240px] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-heading text-base">{t("profile.section.mastering")}</h2>
        <div className="mastering-mobile-sort" role="group" aria-label={t("mastering.sortLabel")}>
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
      {positiveRows.length > 0 && (
        <>
          <ProfileCollapsible
            id={positivePanelId}
            className="mastering-collapsible__content"
            expanded={!positiveCanCollapse || positiveExpanded}
          >
            <MasteryList
              rows={positiveRows}
              previewCount={MASTERY_PREVIEW_COUNT}
              collapsed={positiveCanCollapse && !positiveExpanded}
              locale={lang}
              t={t}
              header={(
                <tr>
                  {SORTABLE_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={column.key === "progress" ? "mastering-table__number-header" : undefined}
                      aria-sort={ariaSortValue(sortKey === column.key, direction)}
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
              )}
            />
          </ProfileCollapsible>
          {positiveCanCollapse && (
            <button
              type="button"
              className="profile-collapsible__toggle mastering-collapsible__toggle"
              aria-expanded={positiveExpanded}
              aria-controls={positivePanelId}
              onClick={togglePositive}
            >
              <span>{t(positiveExpanded ? "mastering.collapse" : "mastering.expand")}</span>
              <span aria-hidden="true">{positiveExpanded ? "↑" : "↓"}</span>
            </button>
          )}
        </>
      )}
      {showZeroTail && zeroRows.length > 0 && (
        <section className="mastering-zero-tail">
          <h3 className="mastering-zero-tail__heading">{t("mastering.zeroTitle")}</h3>
          <ProfileCollapsible
            id={zeroPanelId}
            className="mastering-zero-tail__content"
            expanded={!zeroCanCollapse || zeroExpanded}
          >
            <MasteryList
              rows={zeroRows}
              previewCount={ZERO_PREVIEW_COUNT}
              collapsed={zeroCanCollapse && !zeroExpanded}
              locale={lang}
              t={t}
            />
          </ProfileCollapsible>
          {zeroCanCollapse && (
            <button
              type="button"
              className="profile-collapsible__toggle mastering-zero-tail__toggle"
              aria-expanded={zeroExpanded}
              aria-controls={zeroPanelId}
              onClick={() => setZeroExpanded((value) => !value)}
            >
              <span>{t(zeroExpanded ? "mastering.zeroCollapse" : "mastering.zeroExpand")}</span>
              <span aria-hidden="true">{zeroExpanded ? "↑" : "↓"}</span>
            </button>
          )}
        </section>
      )}
    </div>
  );
}
