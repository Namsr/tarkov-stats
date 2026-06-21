"use client";

import { useI18n } from "@/lib/i18n/context";

interface PercentileBadgeProps {
  playerValue: number;
  medianValue: number;
  higherIsBetter?: boolean;
}

export default function PercentileBadge({
  playerValue,
  medianValue,
  higherIsBetter = true,
}: PercentileBadgeProps) {
  const { t } = useI18n();

  if (medianValue === 0) return null;

  const diff = ((playerValue - medianValue) / medianValue) * 100;
  const isAbove = higherIsBetter ? diff >= 0 : diff <= 0;
  const absDiff = Math.min(Math.abs(diff), 999);

  const bgColor = isAbove
    ? "bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/30"
    : "bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/30";

  const label = isAbove ? t("pct.above") : t("pct.below");

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium ${bgColor}`}
    >
      {isAbove ? "▲" : "▼"} {absDiff.toFixed(0)}% {label}
    </span>
  );
}
