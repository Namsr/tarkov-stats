"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatArenaMetric, formatArenaValue } from "@/components/arena-ui";
import { useI18n } from "@/lib/i18n/context";

interface LeaderboardEntry {
  rank: number;
  aid: number;
  nickname: string;
  bestArp: number;
  matches: number | null;
  kdRatio: number | null;
  winRate: number | null;
  wins: number | null;
}

interface LeaderboardResponse {
  entries?: LeaderboardEntry[];
  total?: number;
  limit?: number;
  error?: string;
}

function entryKey(entry: LeaderboardEntry): string {
  return `${entry.rank}-${entry.aid}`;
}

/**
 * Best ARP leaderboard table. The rating is a single upstream value
 * (BlastGang context) — there is intentionally no per-mode switch.
 */
export default function ArenaLeaderboard({
  limit,
  footerLink,
}: {
  limit: 10 | 500;
  footerLink?: "full" | "compact";
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setEntries(null);
    setTotal(null);
    setError(false);
    fetch(`/api/arena/leaderboard?limit=${limit}`, { signal: controller.signal, cache: "default" })
      .then(async (response) => {
        const body = (await response.json()) as LeaderboardResponse;
        if (!response.ok || !Array.isArray(body.entries)) throw new Error();
        return body;
      })
      .then((body) => {
        if (!controller.signal.aborted) {
          setEntries(body.entries ?? []);
          setTotal(typeof body.total === "number" ? body.total : null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [limit]);

  return (
    <section className="data-panel mt-5 p-5 sm:p-6" aria-labelledby="arena-leaderboard-heading">
      <p className="section-kicker">{t("arena.leaderboard.kicker")}</p>
      <h2 id="arena-leaderboard-heading" className="section-heading mt-1">
        {t("arena.leaderboard.title")}
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
        {t("arena.leaderboard.description")}
      </p>

      {error && (
        <p className="mt-4 text-sm text-[var(--danger)]" role="alert">
          {t("arena.leaderboard.error")}
        </p>
      )}

      {!error && entries === null ? (
        <div className="mt-4 grid gap-2" aria-label={t("common.loading")}>
          {Array.from({ length: Math.min(limit, 10) }).map((_, index) => (
            <div key={index} className="h-11 skeleton rounded-lg" />
          ))}
        </div>
      ) : !error && entries !== null && entries.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">{t("arena.leaderboard.empty")}</p>
      ) : (
        entries !== null && (
          <div className="data-panel mt-4 overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t("arena.leaderboard.rank")}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t("arena.leaderboard.player")}
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    {t("arena.leaderboard.bestArp")}
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    {t("arena.leaderboard.matches")}
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    {t("arena.leaderboard.kd")}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    {t("arena.leaderboard.winRate")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entryKey(entry)} className="border-b border-[var(--card-border)] last:border-0">
                    <td className="px-4 py-3 tabular-nums text-[var(--muted)]">{entry.rank}</td>
                    <th scope="row" className="px-3 py-3 text-left font-medium">
                      <Link
                        href={`/player/arena/${entry.aid}`}
                        className="text-[var(--foreground)] underline-offset-4 hover:underline"
                      >
                        {entry.nickname || `#${entry.aid}`}
                      </Link>
                    </th>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">
                      {footerLink === "full" ? (
                        <Link href="/average/arena/leaderboard" aria-label={t("arena.leaderboard.openFull")}>
                          {formatArenaValue(entry.bestArp)}
                        </Link>
                      ) : (
                        formatArenaValue(entry.bestArp)
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--muted-strong)]">
                      {entry.matches == null ? t("common.notAvailable") : formatArenaValue(entry.matches)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--muted-strong)]">
                      {entry.kdRatio == null ? t("common.notAvailable") : formatArenaMetric(entry.kdRatio, "kd_ratio")}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--muted-strong)]">
                      {entry.winRate == null ? t("common.notAvailable") : formatArenaMetric(entry.winRate, "win_rate")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-[var(--muted)]" aria-live="polite">
          {total !== null ? t("arena.leaderboard.total", { n: total.toLocaleString() }) : null}
        </span>
        {footerLink === "full" ? (
          <Link
            href="/average/arena/leaderboard"
            className="min-h-11 rounded-full border border-[var(--card-border)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition-colors hover:border-[var(--foreground)]"
          >
            {t("arena.leaderboard.openFull")}
          </Link>
        ) : footerLink === "compact" ? (
          <Link
            href="/average/arena"
            className="min-h-11 rounded-full border border-[var(--card-border)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition-colors hover:border-[var(--foreground)]"
          >
            {t("arena.leaderboard.showLess")}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
