"use client";

import { useId, useMemo, useState } from "react";
import Image from "next/image";
import { useI18n } from "@/lib/i18n/context";
import { normalizeProfileSkill } from "@/lib/profile-skills";
import ProfileCollapsible, { ProfileCollapseToggle } from "@/components/ProfileCollapsible";

export function hasVisibleSkills(skills: readonly unknown[] | null | undefined): boolean {
  return (skills ?? []).some((skill) => normalizeProfileSkill(skill) !== null);
}

export default function ProfileSkills({ skills }: { skills: readonly unknown[] | null | undefined }) {
  const { t, lang } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const normalized = useMemo(() => (skills ?? []).flatMap((skill) => {
    const value = normalizeProfileSkill(skill);
    return value ? [value] : [];
  }).sort((a, b) => b.progress - a.progress || a.id.localeCompare(b.id)), [skills]);
  if (!normalized.length) return null;
  return <div className="profile-collection">
    <div className="profile-collection__heading"><h2 className="section-heading">{t("player.skills")}<span className="profile-section-count">{normalized.length}</span></h2></div>
    <ProfileCollapsible id={id} className="profile-skills-collapsible" expanded={expanded || normalized.length <= 3} previewRows={3} rowSelector=".profile-skill">
      <div className="profile-skill-grid" role="list">{normalized.map((skill) => {
        const name = t("skill." + skill.id), percent = skill.percent.toLocaleString(lang, { maximumFractionDigits: 1 });
        return <article key={skill.id} className={`profile-skill ${skill.elite ? "is-elite" : ""}`} role="listitem" data-skill={skill.id}>
          <div className="profile-skill__heading"><Image src={`https://assets.tarkov.dev/skill-${skill.id}-icon.webp`} alt="" width={30} height={30} unoptimized onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /><h3>{name}</h3><strong>{t(skill.elite ? "profile.skillElite" : "profile.skillLevel", { n: skill.level })}</strong></div>
          <div className="profile-skill__progress"><progress max={100} value={skill.percent} aria-label={skill.elite ? `${name}: ${t("profile.skillElite")}` : t("profile.skillProgress", { name, level: skill.level, percent })} /><span aria-hidden="true">{percent}%</span></div>
        </article>;
      })}</div>
    </ProfileCollapsible>
    {normalized.length > 3 && <ProfileCollapseToggle controls={id} expanded={expanded} label={t(expanded ? "profile.collapse" : "profile.skillsExpand")} onToggle={() => setExpanded((value) => !value)} />}
  </div>;
}
