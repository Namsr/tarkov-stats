"use client";

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/context";

interface SkillValue {
  id: string;
  progress: number;
}

function normalizeSkill(value: unknown): SkillValue | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.Id === "string" ? row.Id : typeof row.id === "string" ? row.id : null;
  const progressValue = row.Progress ?? row.progress;
  const progress = Number(progressValue);
  return id && Number.isFinite(progress) && progress > 0 ? { id, progress } : null;
}

export function hasVisibleSkills(skills: readonly unknown[] | null | undefined): boolean {
  return (skills ?? []).some((skill) => normalizeSkill(skill) !== null);
}

export default function ProfileSkills({ skills }: { skills: readonly unknown[] | null | undefined }) {
  const { t } = useI18n();
  const normalized = useMemo(
    () => (skills ?? []).flatMap((skill) => {
      const value = normalizeSkill(skill);
      return value ? [value] : [];
    }).sort((a, b) => b.progress - a.progress || a.id.localeCompare(b.id)),
    [skills],
  );

  if (normalized.length === 0) return null;

  return (
    <div className="data-panel min-h-[240px] p-5">
      <h2 className="section-heading text-base mb-4">{t("player.skills")}</h2>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-80 overflow-y-auto pr-1">
        {normalized.map((skill) => (
          <div key={skill.id} className="flex min-w-0 justify-between gap-2 border-b border-[var(--card-border)] py-2 text-sm">
            <span className="text-[var(--muted-strong)] truncate">{skill.id.replace(/([A-Z])/g, " $1").trim()}</span>
            <span className="text-[var(--accent)] tabular-nums">{Math.floor(skill.progress)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
