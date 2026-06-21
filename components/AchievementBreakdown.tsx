"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";

// Mirrors the /api/average/achievements row shape. Defined locally so this
// client component never imports the server-only route module.
interface AchievementRow {
  id: string;
  name: string;
  side: string;
  rarity: string;
  owners: number;
  samplePct: number;
  officialPct: number;
  meanHours: number;
  stdHours: number;
}

interface Payload {
  total: number;
  achievements: AchievementRow[];
}

type SortKey = "rarity" | "hours" | "owners";

/** Owners below this make the per-achievement mean/std too noisy to trust. */
const MIN_RELIABLE_OWNERS = 5;

function fmtHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "0";
  return h >= 1000 ? `${(h / 1000).toFixed(1)}k` : String(Math.round(h));
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v < 10 ? v.toFixed(2) : v.toFixed(1);
}

function rarityClass(rarity: string): string {
  switch (rarity.toLowerCase()) {
    case "legendary":
      return "text-amber-400";
    case "rare":
      return "text-sky-400";
    default:
      return "text-gray-400";
  }
}

export default function AchievementBreakdown({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("rarity");

  // Lazy-load on first open — the breakdown stays hidden (and uncomputed) until
  // asked for. NOTE: `loading` must NOT be a dependency here — setLoading(true)
  // would re-run the effect, and the re-run's cleanup would cancel this very
  // fetch before it resolves (stuck skeleton). Depend only on open/data.
  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch("/api/average/achievements")
      .then(async (res) => {
        const j = (await res.json()) as Payload & { error?: string };
        if (!res.ok) throw new Error(j.error ?? t("achv.error"));
        return j;
      })
      .then((j) => !cancelled && setData(j))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : t("achv.error")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? data.achievements.filter((a) => a.name.toLowerCase().includes(q))
      : data.achievements.slice();
    filtered.sort((a, b) => {
      if (sort === "rarity") return a.samplePct - b.samplePct; // rarest in our sample first
      if (sort === "hours") return b.meanHours - a.meanHours; // latest-game first
      return b.owners - a.owners;
    });
    return filtered;
  }, [data, query, sort]);

  return (
    <section id="ach-breakdown" className="mt-10">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm uppercase tracking-wider text-gray-400 hover:text-[var(--accent)] transition-colors"
      >
        <span className={`text-gray-500 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        {t("achv.toggle")}
      </button>

      {open && (
        <div className="mt-3 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4">
          <p className="text-xs text-gray-600 mb-4">
            {t("achv.desc.before")}{" "}
            <span className="text-gray-400">{t("achv.desc.highlight")}</span>{" "}
            {t("achv.desc.after")}
          </p>

          {error ? (
            <p className="text-[var(--danger)] text-sm">{error}</p>
          ) : loading || !data ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-8 skeleton rounded" />
              ))}
            </div>
          ) : data.achievements.length === 0 ? (
            <p className="text-gray-500 text-sm">
              {t("achv.empty")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("achv.filterPlaceholder")}
                  className="flex-1 min-w-[140px] px-3 py-1.5 bg-[var(--input-bg)] border border-[var(--card-border)] rounded text-sm focus:outline-none focus:border-[var(--accent)]"
                />
                <div className="flex gap-1 text-xs">
                  {([
                    ["rarity", t("achv.sort.rarity")],
                    ["hours", t("achv.sort.hours")],
                    ["owners", t("achv.sort.owners")],
                  ] as [SortKey, string][]).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setSort(key)}
                      className={`px-2 py-1.5 rounded transition-colors ${
                        sort === key
                          ? "bg-[var(--accent)] text-[var(--background)]"
                          : "bg-[var(--input-bg)] text-gray-400 hover:text-gray-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 bg-[var(--card-bg)] text-[11px] uppercase tracking-wider text-gray-500">
                    <tr className="text-left border-b border-[var(--card-border)]">
                      <th className="py-2 pr-2 font-normal">{t("achv.col.achievement")}</th>
                      <th className="py-2 px-2 font-normal text-right" title={t("achv.col.sample.title")}>
                        {t("achv.col.sample")}
                      </th>
                      <th className="py-2 px-2 font-normal text-right" title={t("achv.col.official.title")}>
                        {t("achv.col.official")}
                      </th>
                      <th className="py-2 px-2 font-normal text-right" title={t("achv.col.typical.title")}>
                        {t("achv.col.typical")}
                      </th>
                      <th className="py-2 pl-2 font-normal text-right">{t("achv.col.owners")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => {
                      const noisy = a.owners < MIN_RELIABLE_OWNERS;
                      return (
                        <tr
                          key={a.id}
                          className="border-b border-[var(--card-border)]/40 hover:bg-[var(--input-bg)]/50"
                        >
                          <td className="py-2 pr-2">
                            <span className={`font-medium ${rarityClass(a.rarity)}`}>{a.name}</span>
                            {a.rarity && (
                              <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-600">
                                {a.rarity}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-right text-[var(--accent)]">{fmtPct(a.samplePct)}%</td>
                          <td className="py-2 px-2 text-right text-gray-500">{fmtPct(a.officialPct)}%</td>
                          <td
                            className={`py-2 px-2 text-right ${noisy ? "text-gray-600" : "text-gray-300"}`}
                            title={noisy ? t("achv.noisy.title") : undefined}
                          >
                            {fmtHours(a.meanHours)}
                            <span className="text-gray-600"> ± {fmtHours(a.stdHours)}</span>
                          </td>
                          <td className="py-2 pl-2 text-right text-gray-500">{a.owners.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="text-[10px] text-gray-600 mt-3">
                {t("achv.footer", {
                  n: data.total.toLocaleString(),
                  min: MIN_RELIABLE_OWNERS,
                })}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
