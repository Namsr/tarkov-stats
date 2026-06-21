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

export default function ComparisonTable({
  nameA,
  nameB,
  rows,
}: ComparisonTableProps) {
  const { t } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--card-border)]">
            <th className="py-3 px-4 text-left text-xs uppercase tracking-wider text-gray-500">
              {t("cmp.metric")}
            </th>
            <th className="py-3 px-4 text-right text-xs uppercase tracking-wider text-[var(--accent)]">
              {nameA}
            </th>
            <th className="py-3 px-4 text-right text-xs uppercase tracking-wider text-[var(--accent)]">
              {nameB}
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
                <td className="py-3 px-4 text-sm text-gray-400">
                  {row.label}
                </td>
                <td className="py-3 px-4 text-right font-medium">
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
                <td className="py-3 px-4 text-right font-medium">
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
    </div>
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(2);
}
