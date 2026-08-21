"use client";

import ProfileAchievements from "@/components/ProfileAchievements";

/** Compatibility wrapper; both profile modes render the shared achievement list. */
export default function SeasonalAchievements({
  achievements,
  loading = false,
  cycleId = "persistent",
  playerHours = 0,
  ownedIds,
}: {
  achievements: readonly unknown[] | null;
  loading?: boolean;
  cycleId?: string;
  playerHours?: number;
  ownedIds?: readonly string[];
}) {
  return (
    <ProfileAchievements
      items={achievements}
      loading={loading}
      cycleId={cycleId}
      mode="seasonal"
      playerHours={playerHours}
      ownedIds={ownedIds}
    />
  );
}
