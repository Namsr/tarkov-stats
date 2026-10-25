import type { AxisKda } from "./axis-kda.ts";
import { matchAxisOcrRows, type AxisOcrParticipant } from "./axis-ocr.ts";

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
  unreadableNames: number;
  conflicts: AxisMatchConflict[];
  roundConflict: { existing: { a: number; b: number }; incoming: { a: number; b: number } } | null;
  submissions: AxisMatchSubmissionReview[];
}

/** Recheck saved name warnings against current aliases, keeping original upload evidence. */
export function recheckAxisMatchReviewNames(
  review: AxisMatchReviewView,
  participants: readonly AxisOcrParticipant[],
): AxisMatchReviewView {
  const unresolved = review.submissions.flatMap((submission) => {
    // Older evidence may omit unmatched names from recognizedNames. Include
    // each occurrence once so duplicate OCR names still abstain in the matcher.
    const names = [...submission.recognizedNames];
    const remaining = new Map<string, number>();
    for (const name of names) remaining.set(name.trim(), (remaining.get(name.trim()) ?? 0) + 1);
    for (const name of submission.unmatchedNames) {
      const count = remaining.get(name.trim()) ?? 0;
      if (count) remaining.set(name.trim(), count - 1);
      else names.push(name);
    }
    const rows = names.map((nickname, index) => ({ id: String(index), nickname }));
    const assignments = matchAxisOcrRows(rows, participants);
    const resolved = new Set(rows.filter((row) => assignments[row.id]).map((row) => row.nickname.trim()));
    return submission.unmatchedNames.filter((name) => !resolved.has(name.trim()));
  });
  return { ...review,
    unmatchedNames: [...new Set(unresolved)],
    nicknameMismatches: [...new Set(unresolved.filter((name) => name.trim()))],
    unreadableNames: unresolved.filter((name) => !name.trim()).length,
  };
}
