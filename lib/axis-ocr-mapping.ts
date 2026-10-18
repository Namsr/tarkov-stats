import type { AxisOcrParticipant, AxisOcrSide } from "./axis-ocr.ts";

type AxisOcrMappingRow = { id: string; side: AxisOcrSide };

export interface AxisOcrMappingSafety {
  duplicateIds: Set<string>;
  mixedSides: Set<AxisOcrSide>;
  blockedKdaSides: Set<AxisOcrSide>;
  sameTeamBothSides: boolean;
  manualOrientationAllowed: boolean;
  safeAssignments: Record<string, string | null>;
}

/** Identify roster mappings that are unsafe for row stats or manual score orientation. */
export function analyzeAxisOcrMappingSafety(
  rows: readonly AxisOcrMappingRow[],
  assignments: Readonly<Record<string, string | null>>,
  participants: readonly Pick<AxisOcrParticipant, "discordId" | "teamIndex">[],
): AxisOcrMappingSafety {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const discordId = assignments[row.id];
    if (discordId) counts.set(discordId, (counts.get(discordId) ?? 0) + 1);
  }
  const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
  const teamById = new Map(participants.map((participant) => [participant.discordId, participant.teamIndex]));
  const teamsBySide: Record<AxisOcrSide, Set<number>> = { left: new Set(), right: new Set() };
  for (const row of rows) {
    const discordId = assignments[row.id];
    if (!discordId || duplicateIds.has(discordId)) continue;
    const teamIndex = teamById.get(discordId);
    if (teamIndex === 0 || teamIndex === 1) teamsBySide[row.side].add(teamIndex);
  }

  const mixedSides = new Set<AxisOcrSide>();
  if (teamsBySide.left.size > 1) mixedSides.add("left");
  if (teamsBySide.right.size > 1) mixedSides.add("right");
  const sameTeamBothSides = teamsBySide.left.size === 1
    && teamsBySide.right.size === 1
    && teamsBySide.left.values().next().value === teamsBySide.right.values().next().value;
  const blockedKdaSides = new Set(mixedSides);
  if (sameTeamBothSides) {
    blockedKdaSides.add("left");
    blockedKdaSides.add("right");
  }

  return {
    duplicateIds,
    mixedSides,
    blockedKdaSides,
    sameTeamBothSides,
    manualOrientationAllowed: duplicateIds.size === 0 && mixedSides.size === 0 && !sameTeamBothSides,
    safeAssignments: Object.fromEntries(rows.map((row) => {
      const discordId = assignments[row.id];
      return [row.id, discordId && !duplicateIds.has(discordId) && teamById.has(discordId) ? discordId : null];
    })),
  };
}
