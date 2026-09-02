"use client";

import { useEffect, useState } from "react";
import ProfileAchievements from "@/components/ProfileAchievements";
import { useI18n } from "@/lib/i18n/context";
import type { GameMode } from "@/types/seasonal";

type AchievementMode = Extract<GameMode, "regular" | "pve" | "seasonal">;

interface AchievementRow {
  id: string;
  name: string;
  nameRu: string | null;
  description: string | null;
  descriptionRu: string | null;
  imageUrl: string | null;
  rarity: string;
  owners: number;
  samplePct: number;
  officialPct: number;
  earlyHours: number;
  unlockHours: number;
}

interface Payload {
  total: number;
  achievements: AchievementRow[];
}

export default function AchievementBreakdown({
  mode = "regular",
  cycleId,
}: {
  mode?: AchievementMode;
  cycleId?: string;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError(false);
      }
    });
    const params = new URLSearchParams({ mode });
    if (mode === "seasonal" && cycleId) params.set("cycle", cycleId);
    fetch(`/api/average/achievements?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("achv.error"));
        return response.json() as Promise<Payload>;
      })
      .then((payload) => {
        if (!controller.signal.aborted) setData(payload);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof Error && fetchError.name === "AbortError") return;
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt, cycleId, mode, t]);

  const items = data?.achievements.map((achievement) => ({
    ...achievement,
    eligibleN: data.total,
    percentage: achievement.samplePct,
    officialPercentage: achievement.officialPct,
  })) ?? [];

  return (
    <section id="ach-breakdown" className="mt-10">
      {error ? (
        <div className="data-panel min-h-[240px] p-5">
          <h2 className="section-heading text-base">{t("profile.section.achievements")}</h2>
          <p className="mt-4 text-sm text-[var(--danger)]" role="alert">{t("achv.error")}</p>
          <button
            type="button"
            className="ghost-button mt-4 min-h-11"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("achv.retry")}
          </button>
        </div>
      ) : (
        <ProfileAchievements
          items={items}
          loading={loading || data === null}
          mode={mode}
          cycleId={cycleId ?? "persistent"}
          variant="average"
        />
      )}
    </section>
  );
}
