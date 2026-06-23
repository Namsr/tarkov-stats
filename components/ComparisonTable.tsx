"use client";

import { useI18n } from "@/lib/i18n/context";
import PercentileBadge from "./PercentileBadge";

export interface ComparisonRow {
  label: string;
  valueA: number;
  valueB: number;
  /** Decimals for displaying both values (counts use 0). */
  decimals?: number;
  suffix?: string;
  /** Direction for the Δ badge colour; defaults to "higher = above". */
  higherIsBetter?: boolean;
}

interface ComparisonTableProps {
  nameA: string;
  nameB: string;
  rows: ComparisonRow[];
}

// Fixed-layout comparison table shared by both modes: Metric | A | B | Δ%. Widths
// are constant (table-fixed) so switching the opponent column never reflows the
// table; only column B's header/values and the Δ numbers change.
export default function ComparisonTable({ nameA, nameB, rows }: ComparisonTableProps) {
  const { t } = useI18n();
  return (
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr className="border-b border-[var(--card-border)] text-[11px] uppercase tracking-wider">
          <th className="w-[30%] py-2 px-1.5 text-left text-gray-500">{t("cmp.metric")}</th>
          <th className="w-[19%] py-2 px-1.5 text-right text-[var(--accent)]">
            <span className="block truncate" title={nameA}>{nameA}</span>
          </th>
          <th className="w-[19%] py-2 px-1.5 text-right text-gray-400">
            <span className="block truncate" title={nameB}>{nameB}</span>
          </th>
          <th className="w-[32%] py-2 px-1.5 text-right text-gray-500" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-b border-[var(--card-border)]/50">
            <td className="py-2 px-1.5 text-sm text-gray-400 break-words">{row.label}</td>
            <td className="py-2 px-1.5 text-right text-sm font-medium text-[var(--accent)] tabular-nums">
              {fmt(row.valueA, row.decimals)}
              {row.suffix ?? ""}
            </td>
            <td className="py-2 px-1.5 text-right text-sm text-gray-400 tabular-nums">
              {fmt(row.valueB, row.decimals)}
              {row.suffix ?? ""}
            </td>
            <td className="py-2 px-1.5 text-right">
              <PercentileBadge
                playerValue={row.valueA}
                medianValue={row.valueB}
                higherIsBetter={row.higherIsBetter ?? true}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmt(v: number, decimals = 0): string {
  if (decimals <= 0) return Math.round(v).toLocaleString();
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
