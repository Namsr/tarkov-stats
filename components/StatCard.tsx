interface StatCardProps {
  label: string;
  value: string | number;
  benchmarkDiff?: number | null;
  suffix?: string;
}

export default function StatCard({ label, value, benchmarkDiff, suffix }: StatCardProps) {
  const diffColor =
    benchmarkDiff != null
      ? benchmarkDiff >= 0
        ? "text-[var(--success)]"
        : "text-[var(--danger)]"
      : "";

  const diffSign = benchmarkDiff != null && benchmarkDiff >= 0 ? "+" : "";

  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-gray-500">
        {label}
      </span>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-[var(--accent)]">
          {value}
          {suffix && <span className="text-sm text-gray-400 ml-1">{suffix}</span>}
        </span>
        {benchmarkDiff != null && (
          <span className={`text-sm font-medium ${diffColor} mb-0.5`}>
            {diffSign}{benchmarkDiff.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
