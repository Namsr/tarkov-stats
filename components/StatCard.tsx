interface StatCardProps {
  label: string;
  value: string | number;
  benchmarkDiff?: number | null;
  suffix?: string;
  className?: string;
}

export default function StatCard({ label, value, benchmarkDiff, suffix, className = "" }: StatCardProps) {
  const diffColor =
    benchmarkDiff != null
      ? benchmarkDiff >= 0
        ? "text-[var(--success)]"
        : "text-[var(--danger)]"
      : "";

  const diffSign = benchmarkDiff != null && benchmarkDiff >= 0 ? "+" : "";

  return (
    <div className={`metric-card flex flex-col gap-2 ${className}`}>
      <span className="metric-card__label">
        {label}
      </span>
      <div className="flex items-end gap-2">
        <span className="metric-card__value">
          {value}
          {suffix && <span className="metric-card__suffix ml-1">{suffix}</span>}
        </span>
        {benchmarkDiff != null && (
          <span className={`text-xs font-bold ${diffColor} mb-0.5`}>
            {diffSign}{benchmarkDiff.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
