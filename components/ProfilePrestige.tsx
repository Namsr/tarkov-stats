"use client";

import Image from "next/image";
import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";

export default function ProfilePrestige({ level }: { level?: number | null }) {
  const { t } = useI18n();
  const [failedLevel, setFailedLevel] = useState<number | null>(null);
  if (level == null || !Number.isSafeInteger(level) || level <= 0) return null;

  const label = t("player.prestigeLabel", { n: level });
  if (failedLevel === level) return <span className="profile-prestige-fallback">{label}</span>;

  return (
    <Image
      className="profile-prestige"
      src={`https://assets.tarkov.dev/prestige-${level}-icon.webp`}
      alt={label}
      title={label}
      width={44}
      height={44}
      unoptimized
      loading="eager"
      referrerPolicy="no-referrer"
      onError={() => setFailedLevel(level)}
    />
  );
}
