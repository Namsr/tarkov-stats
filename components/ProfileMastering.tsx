"use client";

import { useId, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import ProfileCollapsible, { ProfileCollapseToggle } from "@/components/ProfileCollapsible";
import { displayedWeaponMasteryProgress, sortWeaponMastery, type ProfileWeaponMastery, type WeaponMasterySortDirection, type WeaponMasterySortKey } from "@/lib/profile-mastery";

function normalizeMastery(value: unknown): ProfileWeaponMastery | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const weapon = typeof row.weapon === "string" ? row.weapon.trim() : "";
  const progress = typeof row.progress === "number" ? row.progress : NaN;
  const level = Number(row.level);
  return id && weapon && Number.isFinite(progress) && progress >= 0 && Number.isInteger(level) && level >= 1 && level <= 3
    ? { id, weapon, progress, level: level as 1 | 2 | 3 } : null;
}

export function hasVisibleMastery(items: readonly unknown[] | null | undefined): boolean {
  return (items ?? []).some((item) => normalizeMastery(item) !== null);
}

export default function ProfileMastering({ items }: { items: readonly unknown[] | null | undefined }) {
  const { t, lang } = useI18n();
  const [sortKey, setSortKey] = useState<WeaponMasterySortKey>("progress");
  const [direction, setDirection] = useState<WeaponMasterySortDirection>("desc");
  const [expanded, setExpanded] = useState(false);
  const [showZero, setShowZero] = useState(false);
  const id = useId();
  const normalized = useMemo(() => (items ?? []).flatMap((item) => {
    const row = normalizeMastery(item);
    return row ? [row] : [];
  }), [items]);
  const sorted = useMemo(() => sortWeaponMastery(normalized.filter((row) => showZero || displayedWeaponMasteryProgress(row.progress) > 0), sortKey, direction, lang), [normalized, showZero, sortKey, direction, lang]);
  if (!normalized.length) return null;
  const canCollapse = sorted.length > 5;
  function changeSort(key: WeaponMasterySortKey) {
    setDirection(key === sortKey ? direction === "asc" ? "desc" : "asc" : key === "progress" ? "desc" : "asc");
    setSortKey(key);
  }
  return <div className="profile-collection">
    <div className="profile-collection__heading"><h2 className="section-heading">{t("profile.section.mastering")}<span className="profile-section-count">{normalized.length}</span></h2></div>
    <ProfileCollapsible id={id} className="mastering-collapsible__content" expanded={!canCollapse || expanded} previewRows={5} rowSelector="tbody > tr">
      <div className="mastering-table-wrap"><table className="mastering-table">
        <caption className="sr-only">{t("mastering.tableCaption")}</caption>
        <thead><tr>{([["weapon", "mastering.col.weapon"], ["progress", "mastering.col.progress"]] as const).map(([key, labelKey]) => <th key={key} scope="col" className={key === "progress" ? "mastering-table__number-header" : undefined} aria-sort={sortKey === key ? direction === "asc" ? "ascending" : "descending" : "none"}>
          <button type="button" className="mastering-table__sort" aria-pressed={sortKey === key} aria-label={t("mastering.sortBy", { column: t(labelKey), direction: t((sortKey === key ? direction === "desc" : key === "weapon") ? "mastering.sort.directionAsc" : "mastering.sort.directionDesc") })} onClick={() => changeSort(key)}>{t(labelKey)}{sortKey === key && <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}</button>
        </th>)}<th scope="col" className="mastering-table__number-header">{t("metric.level")}</th></tr></thead>
        <tbody>{sorted.map((row) => <tr key={row.id}><th scope="row">{row.weapon}</th><td className="mastering-table__number">{displayedWeaponMasteryProgress(row.progress).toLocaleString(lang)}</td><td className="mastering-table__number"><span className="profile-mastery-level"><span aria-hidden="true">{[1, 2, 3].map((level) => <i key={level} className={level <= row.level ? "is-earned" : undefined} />)}</span>{row.level}</span></td></tr>)}</tbody>
      </table></div>
    </ProfileCollapsible>
    {canCollapse && <ProfileCollapseToggle controls={id} expanded={expanded} label={t(expanded ? "mastering.collapse" : "mastering.expand")} onToggle={() => setExpanded((value) => !value)} />}
    {normalized.some((row) => displayedWeaponMasteryProgress(row.progress) === 0) && <div className="profile-collection__filter"><label><input type="checkbox" checked={showZero} onChange={(event) => { setShowZero(event.target.checked); if (event.target.checked) setExpanded(true); }} />{t("profile.zeroWeapons")}</label></div>}
  </div>;
}
