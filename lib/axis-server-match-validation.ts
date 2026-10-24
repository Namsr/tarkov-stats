import { getArenaProfile } from "@/lib/arena/service";
import { analyzeAxisOcrMappingSafety, type AxisOcrMappingSafety } from "./axis-ocr-mapping.ts";
import { inferAxisOcrLeftTeam, matchAxisOcrRows, parseAxisOcrCounter, type AxisOcrContext, type AxisOcrResult } from "./axis-ocr.ts";
import { axisMatchRosterFingerprintForMatch } from "./axis-match-submission.ts";
import type { AxisMatch } from "./axis-history.ts";

export class AxisOcrMatchMismatchError extends Error {}

/** AXIS screenshots are the fixed two-sided five-player scoreboard. */
export function isSupportedAxisOcrRoster(context: AxisOcrContext): boolean {
  if (context.participants.length !== 10) return false;
  const ids = new Set<string>();
  const teamCounts = [0, 0];
  for (const participant of context.participants) {
    if (!participant.discordId || ids.has(participant.discordId)
      || (participant.teamIndex !== 0 && participant.teamIndex !== 1)) return false;
    ids.add(participant.discordId);
    teamCounts[participant.teamIndex]++;
  }
  return teamCounts[0] === 5 && teamCounts[1] === 5;
}

/** Build the trusted roster used for both player submissions and moderator uploads. */
export async function axisOcrContextForMatch(match: AxisMatch): Promise<AxisOcrContext> {
  const participants = match.teams.flatMap((team, teamIndex) => team.players.map((player) => ({
    discordId: player.id,
    teamIndex,
    historyName: player.name,
    arenaNickname: null as string | null,
    aid: player.profile?.aid,
  })));
  const baseContext = { matchNumber: match.number, participants };
  // Reject malformed/unsupported archives before making any profile requests.
  if (!isSupportedAxisOcrRoster(baseContext)) throw new AxisOcrMatchMismatchError("Unsupported AXIS roster");
  const aids = new Set<number>();
  for (const participant of participants) {
    const aid = participant.aid;
    if (typeof aid === "number" && Number.isSafeInteger(aid) && aid > 0) aids.add(aid);
  }
  const nicknames = new Map<number, string | null>();
  await Promise.all([...aids].map(async (aid) => {
    try {
      const profile = await getArenaProfile(aid);
      const nickname = profile?.nickname?.trim() ?? "";
      nicknames.set(aid, nickname && nickname.toLowerCase() !== "unknown" ? nickname : null);
    } catch { nicknames.set(aid, null); }
  }));
  return {
    matchNumber: baseContext.matchNumber,
    participants: participants.map(({ aid, ...participant }) => ({
      ...participant,
      arenaNickname: typeof aid === "number" && Number.isSafeInteger(aid) && aid > 0 ? nicknames.get(aid) ?? null : null,
    })),
  };
}

export function validateAxisOcrNames(result: AxisOcrResult, context: AxisOcrContext) {
  if (!isSupportedAxisOcrRoster(context) || result.rows.length !== 10) {
    throw new AxisOcrMatchMismatchError("Screenshot does not contain a complete AXIS scoreboard");
  }
  const sideCounts = { left: 0, right: 0 };
  const rowIds = new Set<string>();
  for (const row of result.rows) {
    if (rowIds.has(row.id) || (row.side !== "left" && row.side !== "right")) {
      throw new AxisOcrMatchMismatchError("Screenshot rows are ambiguous");
    }
    rowIds.add(row.id);
    sideCounts[row.side]++;
  }
  if (sideCounts.left !== 5 || sideCounts.right !== 5) {
    throw new AxisOcrMatchMismatchError("Screenshot sides do not contain five players");
  }
  const assignments = matchAxisOcrRows(result.rows, context.participants);
  const matchedIds = new Set(Object.values(assignments).filter((id): id is string => Boolean(id)));
  const recognizedNames = result.rows.map((row) => row.nickname).filter((name) => name.trim());
  const unmatchedNames = result.rows.filter((row) => row.nickname.trim() && !assignments[row.id]).map((row) => row.nickname);
  if (matchedIds.size < 8 || unmatchedNames.length > 2) {
    throw new AxisOcrMatchMismatchError("Screenshot names do not match this match");
  }
  const safety = analyzeAxisOcrMappingSafety(result.rows, assignments, context.participants);
  if (!safety.manualOrientationAllowed || safety.blockedKdaSides.size > 0 || safety.mixedSides.size > 0) {
    throw new AxisOcrMatchMismatchError("Screenshot player sides are ambiguous");
  }
  const leftTeam = inferAxisOcrLeftTeam(result.rows, safety.safeAssignments, context.participants);
  if (leftTeam === null) throw new AxisOcrMatchMismatchError("Screenshot team sides are ambiguous");
  return { assignments, matchedIds, recognizedNames, unmatchedNames, safety, leftTeam };
}

export function axisOcrStatsPlayerIds(result: AxisOcrResult, validation: {
  safety: AxisOcrMappingSafety;
}): Set<string> {
  const ids = new Set<string>();
  for (const row of result.rows) {
    const discordId = validation.safety.safeAssignments[row.id];
    if (!discordId || validation.safety.blockedKdaSides.has(row.side)) continue;
    if (parseAxisOcrCounter(row.kills) !== null && parseAxisOcrCounter(row.deaths) !== null
      && parseAxisOcrCounter(row.assists) !== null) ids.add(discordId);
  }
  return ids;
}

export function axisOcrRosterFingerprint(match: AxisMatch): string {
  return axisMatchRosterFingerprintForMatch(match);
}
