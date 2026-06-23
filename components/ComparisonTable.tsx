"use client";

import { useI18n } from "@/lib/i18n/context";

interface ComparisonRow {
  label: string;
  valueA: number;
  valueB: number;
  suffix?: string;
  higherIsBetter?: boolean;
}

interface ComparisonTableProps {
  nameA: string;
  nameB: string;
  rows: ComparisonRow[];
}

// Fixed layout so the table always fits its (narrow) column — no horizontal
// scroll. Columns share the width by fixed fractions; long nicknames truncate,
// long metric labels wrap.
export default function ComparisonTable({
  nameA,
  nameB,
  rows,
}: ComparisonTableProps) {
  const { t } = useI18n();
  return (
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr className="border-b border-[var(--card-border)]">
          <th className="w-[40%] py-2 px-2 text-left text-xs uppercase tracking-wider text-gray-500">
            {t("cmp.metric")}
          </th>
          <th className="w-[30%] py-2 px-2 text-right text-xs uppercase tracking-wider text-[var(--accent)]">
            <span className="block truncate" title={nameA}>
              {nameA}
            </span>
          </th>
          <th className="w-[30%] py-2 px-2 text-right text-xs uppercase tracking-wider text-[var(--accent)]">
            <span className="block truncate" title={nameB}>
              {nameB}
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const higherIsBetter = row.higherIsBetter ?? true;
          const aWins = higherIsBetter
            ? row.valueA > row.valueB
            : row.valueA < row.valueB;
          const bWins = higherIsBetter
            ? row.valueB > row.valueA
            : row.valueB < row.valueA;
          const tied = row.valueA === row.valueB;

          return (
            <tr
              key={row.label}
              className="border-b border-[var(--card-border)]/50 hover:bg-[var(--card-border)]/20 transition-colors"
            >
              <td className="py-2 px-2 text-sm text-gray-400 break-words">
                {row.label}
              </td>
              <td className="py-2 px-2 text-right font-medium text-sm tabular-nums">
                <span
                  className={
                    tied
                      ? "text-gray-400"
                      : aWins
                      ? "text-[var(--success)]"
                      : "text-[var(--danger)]"
                  }
                >
                  {formatValue(row.valueA)}
                  {row.suffix ?? ""}
                </span>
              </td>
              <td className="py-2 px-2 text-right font-medium text-sm tabular-nums">
                <span
                  className={
                    tied
                      ? "text-gray-400"
                      : bWins
                      ? "text-[var(--success)]"
                      : "text-[var(--danger)]"
                  }
                >
                  {formatValue(row.valueB)}
                  {row.suffix ?? ""}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(2);
}
