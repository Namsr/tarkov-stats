"use client";

import { useI18n } from "@/lib/i18n/context";

interface PercentileBadgeProps {
  percentile: number | null | undefined;
}

export default function PercentileBadge({ percentile }: PercentileBadgeProps) {
  const { t } = useI18n();

  if (percentile == null || !Number.isFinite(percentile) || percentile < 0 || percentile > 100) return null;

  const value = Math.round(percentile);
  return (
    <span
      className="inline-flex items-center rounded border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-[var(--accent)]"
      title={t("pct.badge", { value })}
      aria-label={t("pct.badge", { value })}
    >
      P{value}
    </span>
  );
}
