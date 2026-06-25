"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { EVENT_ACHIEVEMENT_IDS } from "@/lib/cheater-score";

interface AchievementRow {
  id: string;
  name: string;
  rarity: string;
  owners: number;
  samplePct: number;
  meanHours: number;
  stdHours: number;
}

interface Payload {
  total: number;
  achievements: AchievementRow[];
}

interface EarlyUnlock {
  id: string;
  name: string;
  rarity: string;
  z: number;
  meanHours: number;
  samplePct: number;
}

// Gates so we don't flag noise: the whole sample must be non-trivial, each
// achievement needs enough owners for a meaningful mean/std, and we only surface
// unlocks at least this many std-devs earlier than typical.
const MIN_SAMPLE = 30;
const MIN_OWNERS = 10;
const Z_THRESHOLD = -1.5;
const MAX_SHOWN = 6;

function fmtHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "0";
  return h >= 1000 ? `${(h / 1000).toFixed(1)}k` : String(Math.round(h));
}

/**
 * Flags achievements this player unlocked with far fewer hours than typical,
 * using the sample-wide baseline (mean ± std of owner playtime). A strongly
 * negative z = "earned much earlier than most" — impressive, or a cheater-score
 * signal. Renders nothing until the sample is large enough to trust.
 */
export default function EarlyUnlocks({
  playerHours,
  ownedIds,
}: {
  playerHours: number;
  ownedIds: string[];
}) {
  const { t } = useI18n();
  const [unlocks, setUnlocks] = useState<EarlyUnlock[] | null>(null);

  useEffect(() => {
    if (!(playerHours > 0) || ownedIds.length === 0) {
      setUnlocks([]);
      return;
    }
    const owned = new Set(ownedIds);
    let cancelled = false;
    fetch("/api/average/achievements")
      .then((res) => (res.ok ? (res.json() as Promise<Payload>) : null))
      .then((data) => {
        if (cancelled || !data || data.total < MIN_SAMPLE) {
          if (!cancelled) setUnlocks([]);
          return;
        }
        const flagged = data.achievements
          .filter(
            (a) =>
              owned.has(a.id) &&
              !EVENT_ACHIEVEMENT_IDS.has(a.id) && // event-only achievements aren't a cheating signal
              a.owners >= MIN_OWNERS &&
              a.stdHours > 0
          )
          .map((a) => ({
            id: a.id,
            name: a.name,
            rarity: a.rarity,
            z: (playerHours - a.meanHours) / a.stdHours,
            meanHours: a.meanHours,
            samplePct: a.samplePct,
          }))
          .filter((u) => u.z <= Z_THRESHOLD)
          .sort((a, b) => a.z - b.z)
          .slice(0, MAX_SHOWN);
        setUnlocks(flagged);
      })
      .catch(() => !cancelled && setUnlocks([]));
    return () => {
      cancelled = true;
    };
  }, [playerHours, ownedIds]);

  // Hide entirely until we have something noteworthy to show.
  if (!unlocks || unlocks.length === 0) return null;

  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4">
      <h2 className="text-sm uppercase tracking-wider text-gray-500 mb-1">{t("early.heading")}</h2>
      <p className="text-xs text-gray-600 mb-3">
        {t("early.description")}
      </p>
      <div className="space-y-2">
        {unlocks.map((u) => {
          const strong = u.z <= -2.5;
          return (
            <div
              key={u.id}
              className="flex items-center justify-between gap-3 text-sm py-1.5 px-2 rounded bg-[var(--input-bg)]"
            >
              <div className="min-w-0">
                <div className="text-gray-200 truncate">{u.name}</div>
                <div className="text-[11px] text-gray-500">
                  {fmtHours(playerHours)} {t("unit.h")} · {t("early.typical", { h: fmtHours(u.meanHours) })} ·{" "}
                  {t("early.haveIt", {
                    pct: u.samplePct < 10 ? u.samplePct.toFixed(2) : u.samplePct.toFixed(1),
                  })}
                </div>
              </div>
              <span
                className={`shrink-0 font-medium tabular-nums ${
                  strong ? "text-amber-400" : "text-gray-400"
                }`}
                title={t("early.sigmaTooltip")}
              >
                {u.z.toFixed(1)}σ
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
