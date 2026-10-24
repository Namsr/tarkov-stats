import type { AxisKda } from "./axis-kda.ts";

export type AxisUploadRole = "player" | "moderator";

/** Bind OCR to player IDs, teams and names, independent of upstream row order. */
export function axisMatchRosterFingerprintForMatch(match: {
  teams: readonly { players: readonly { id: string; name: string }[] }[];
}): string {
  return JSON.stringify(match.teams.flatMap((team, teamIndex) =>
    team.players.map(player => [player.id, teamIndex, player.name] as const))
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]) || left[2].localeCompare(right[2])));
}

/** The OCR evidence kept with the most recent screenshot submission. */
export interface AxisMatchReview {
  matchNumber: number;
  photoRevision: string;
  recognizedNames: string[];
  unmatchedNames: string[];
  missingDiscordIds: string[];
  uploadedBy: string;
  uploadedAt: number;
}

export interface AxisMatchConflict {
  discordId: string;
  name: string;
  existing: AxisKda;
  incoming: AxisKda;
}

export interface AxisMatchSubmissionReview extends AxisMatchReview {
  conflicts: AxisMatchConflict[];
  roundConflict: { existing: { a: number; b: number }; incoming: { a: number; b: number } } | null;
}

export interface AxisMatchReviewView extends AxisMatchReview {
  missingStats: string[];
  nicknameMismatches: string[];
  conflicts: AxisMatchConflict[];
  roundConflict: { existing: { a: number; b: number }; incoming: { a: number; b: number } } | null;
  submissions: AxisMatchSubmissionReview[];
}
