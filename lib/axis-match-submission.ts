import type { AxisKda } from "./axis-kda.ts";
import { inferAxisOcrLeftTeam, matchAxisOcrRows, type AxisOcrParticipant, type AxisOcrRow } from "./axis-ocr.ts";
import { analyzeAxisOcrMappingSafety } from "./axis-ocr-mapping.ts";

export type AxisUploadRole = "player" | "moderator";
export type AxisOcrNameRow = Pick<AxisOcrRow, "id" | "side" | "nickname"> & {
  /** Original trusted assignment, before any later Arena nickname changes. */
  matchedDiscordId?: string | null;
};

/** Bound persisted metadata to the trusted two-sided scoreboard shape. */
export function parseAxisOcrNameRows(input: unknown): AxisOcrNameRow[] {
  if (!Array.isArray(input) || input.length !== 10) throw new TypeError("Invalid OCR name rows");
  const ids = new Set<string>();
  const sides = { left: 0, right: 0 };
  const matchedIds = new Set<string>();
  return input.map((row) => {
    if (!row || typeof row.id !== "string" || !row.id.length || row.id.length > 200 || ids.has(row.id)
      || (row.side !== "left" && row.side !== "right") || typeof row.nickname !== "string" || row.nickname.length > 200) {
      throw new TypeError("Invalid OCR name row");
    }
    if (row.matchedDiscordId !== undefined && row.matchedDiscordId !== null) {
      if (typeof row.matchedDiscordId !== "string" || !row.matchedDiscordId.length || row.matchedDiscordId.length > 200
        || matchedIds.has(row.matchedDiscordId)) throw new TypeError("Invalid OCR name assignment");
      matchedIds.add(row.matchedDiscordId);
    }
    ids.add(row.id);
    sides[row.side as "left" | "right"]++;
    if (sides[row.side as "left" | "right"] > 5) throw new TypeError("Invalid OCR name sides");
    return { id: row.id, side: row.side, nickname: row.nickname,
      ...(row.matchedDiscordId === undefined ? {} : { matchedDiscordId: row.matchedDiscordId }) };
  });
}

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
  nameRows?: AxisOcrNameRow[] | null;
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
    if (!submission.nameRows) return submission.unmatchedNames;
    const rows = parseAxisOcrNameRows(submission.nameRows);
    // A later OCR model may read the legacy image differently. Such rows must
    // not be used to clear warnings from the original recognition result.
    const names = rows.map((row) => row.nickname).filter((name) => name.trim());
    if (JSON.stringify(names.map((name) => name.trim())) !== JSON.stringify(submission.recognizedNames.map((name) => name.trim()))) {
      return submission.unmatchedNames;
    }
    const assignments = matchAxisOcrRows(rows, participants);
    // A later alias swap must not move an originally matched row to another
    // player. Neither refreshed Arena aliases nor refreshed archive names can
    // prove its original identity: retain the original upload evidence below.
    const originallyUnmatched = new Set(submission.unmatchedNames.map((name) => name.trim()));
    // Legacy uploads lack per-row identities. A single original missing player
    // can still be proved by exclusion when all ten current aliases are unique,
    // the sole unmatched name resolves to that player, and team checks below pass.
    // This clears a name warning only; it never reassigns saved K/D/A.
    const unmatchedRows = rows.filter((row) => originallyUnmatched.has(row.nickname.trim()));
    const legacySingleMissing = rows.every((row) => row.matchedDiscordId === undefined)
      && submission.unmatchedNames.length === 1
      && submission.unmatchedNames[0].trim() !== ""
      && submission.missingDiscordIds.length === 1
      && unmatchedRows.length === 1
      && assignments[unmatchedRows[0].id] === submission.missingDiscordIds[0]
      && Object.values(assignments).filter(Boolean).length === 10;
    if (rows.some((row) => {
      if (!row.nickname.trim() || originallyUnmatched.has(row.nickname.trim())) return false;
      const originalId = row.matchedDiscordId;
      return originalId ? assignments[row.id] !== originalId : !legacySingleMissing;
    })) {
      return submission.unmatchedNames;
    }
    const safety = analyzeAxisOcrMappingSafety(rows, assignments, participants);
    if (Object.values(assignments).filter(Boolean).length < 8 || !safety.manualOrientationAllowed
      || inferAxisOcrLeftTeam(rows, safety.safeAssignments, participants) === null) return submission.unmatchedNames;
    const resolved = new Set(rows.filter((row) => assignments[row.id]).map((row) => row.nickname.trim()));
    return submission.unmatchedNames.filter((name) => !resolved.has(name.trim()));
  });
  return { ...review,
    unmatchedNames: [...new Set(unresolved)],
    nicknameMismatches: [...new Set(unresolved.filter((name) => name.trim()))],
    unreadableNames: unresolved.filter((name) => !name.trim()).length,
  };
}
