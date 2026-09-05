"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaModeKey } from "@/types/arena";
import type {
  LeaderboardMode,
  LeaderboardRankResponse,
  LeaderboardRow,
} from "@/types/leaderboard";

function rankText(row: LeaderboardRow): string | null {
  if (row.status === "ranked" && row.primaryRank != null) return `#${row.primaryRank}`;
  if (row.status === "insufficient_sample" && row.groupStart != null) return `#${row.groupStart}+`;
  return null;
}

export default function LeaderboardRankLink({
  aid,
  mode,
  arenaMode,
  cycleId,
  revision,
}: {
  aid: number;
  mode: LeaderboardMode;
  arenaMode?: ArenaModeKey;
  cycleId?: string;
  revision?: string | number | null;
}) {
  const { t } = useI18n();
  const requestKey = `${mode}:${arenaMode ?? ""}:${cycleId ?? ""}:${aid}:${revision ?? ""}`;
  const [result, setResult] = useState<{ key: string; subject: LeaderboardRow | null } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const resolvedArenaMode = mode === "arena" ? arenaMode ?? "blastGang" : null;
    const params = new URLSearchParams({ mode, aid: String(aid) });
    if (resolvedArenaMode) params.set("arenaMode", resolvedArenaMode);
    if (mode === "pvp-season" && cycleId) params.set("cycle", cycleId);
    fetch(`/api/leaderboard/rank?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<LeaderboardRankResponse>;
      })
      .then((response) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, subject: response?.subject ?? null });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key: requestKey, subject: null });
      });
    return () => controller.abort();
  }, [aid, arenaMode, cycleId, mode, requestKey, revision]);

  if (result?.key !== requestKey) {
    return <span className="leaderboard-rank leaderboard-rank--loading skeleton" aria-hidden="true" />;
  }

  const subject = result.subject;
  const text = subject ? rankText(subject) : null;
  if (!subject || !text) {
    return <span className="leaderboard-rank leaderboard-rank--unavailable">{t("leaderboard.rank.unavailable")}</span>;
  }

  const params = new URLSearchParams({ mode, sort: "primary", aid: String(aid) });
  if (mode === "arena") params.set("arenaMode", arenaMode ?? "blastGang");
  if (mode === "pvp-season" && cycleId) params.set("cycle", cycleId);
  const labelKey = subject.status === "insufficient_sample"
    ? "leaderboard.rank.groupAria"
    : "leaderboard.rank.aria";

  return (
    <Link
      href={`/leaderboard?${params}`}
      className="leaderboard-rank"
      aria-label={t(labelKey, { rank: text })}
    >
      {text}
    </Link>
  );
}
