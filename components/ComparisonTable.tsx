"use client";

import { useI18n } from "@/lib/i18n/context";
import PercentileBadge from "./PercentileBadge";

export interface ComparisonRow {
  key: string;
  label: string;
  valueA: number | null;
  valueB: number | null;
  benchmark: number | null;
  percentile: number | null;
  decimals?: number;
  suffix?: string;
}

interface ComparisonTableProps {
  nameA: string;
  nameB: string;
  rows: ComparisonRow[];
}

export default function ComparisonTable({ nameA, nameB, rows }: ComparisonTableProps) {
  const { t, lang } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
        <caption className="sr-only">{t("compare.tableCaption")}</caption>
        <thead>
          <tr className="border-b border-[var(--card-border)] text-[10px] uppercase tracking-wider">
            <th scope="col" className="w-[24%] py-2.5 px-1.5 text-left text-[var(--muted)]">{t("cmp.metric")}</th>
            <th scope="col" className="w-[22%] py-2 px-1.5 text-right text-[var(--accent)]">
              <span className="block truncate" title={nameA}>{nameA}</span>
            </th>
            <th scope="col" className="w-[22%] py-2.5 px-1.5 text-right text-[var(--muted-strong)]">
              <span className="block truncate" title={nameB}>{nameB}</span>
            </th>
            <th scope="col" className="w-[20%] py-2.5 px-1.5 text-right text-[var(--muted)]">{t("compare.cohortBenchmark")}</th>
            <th scope="col" className="w-[12%] py-2.5 px-1.5 text-right text-[var(--muted)]">{t("compare.percentile")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-[var(--card-border)]/50">
              <th scope="row" className="py-2.5 px-1.5 text-left text-[var(--muted-strong)] break-words">{row.label}</th>
              <td className="py-2.5 px-1.5 text-right font-medium text-[var(--accent)] tabular-nums">
                {metricText(row.valueA, row.decimals, row.suffix, lang)}
              </td>
              <td className="py-2.5 px-1.5 text-right text-[var(--muted-strong)] tabular-nums">
                {metricText(row.valueB, row.decimals, row.suffix, lang)}
              </td>
              <td className="py-2.5 px-1.5 text-right text-[var(--muted-strong)] tabular-nums">
                {metricText(row.benchmark, row.decimals, row.suffix, lang)}
              </td>
              <td className="py-2.5 px-1.5 text-right">
                <PercentileBadge percentile={row.percentile} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function metricText(value: number | null, decimals: number | undefined, suffix: string | undefined, lang: string): string {
  const text = fmt(value, decimals, lang);
  return value == null ? text : `${text}${suffix ?? ""}`;
}

function fmt(value: number | null, decimals: number | undefined, lang: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if ((decimals ?? 0) <= 0) return Math.round(value).toLocaleString(lang);
  return value.toLocaleString(lang, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
