import { AXIS_KDA_MAX } from "./axis-kda.ts";

export type AxisOcrSide = "left" | "right";

/** Crop coordinates are measured in original image pixels. */
export interface AxisOcrCrop { x: number; y: number; width: number; height: number }
export interface AxisOcrImage { src: string; width: number; height: number; key: string; isNew: boolean }
export interface AxisOcrRow {
  id: string;
  side: AxisOcrSide;
  index: number;
  nickname: string;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  numberConfidence: { kills: number | null; deaths: number | null; assists: number | null };
  confidence: number;
}
export interface AxisOcrResult {
  score: { left: number | null; right: number | null };
  scoreConfidence: { left: number | null; right: number | null };
  rows: AxisOcrRow[];
  crop: AxisOcrCrop;
}
export interface AxisOcrParticipant {
  discordId: string;
  teamIndex: number;
  historyName: string;
  arenaNickname: string | null;
}
export interface AxisOcrContext { matchNumber: number; participants: AxisOcrParticipant[] }

/** A row uses its weakest numeric model score; never present a perfect-accuracy guarantee. */
export function axisOcrConfidencePercent(readings: readonly { value: number | null; confidence: number | null }[]): number | null {
  if (!readings.length) return null;
  let lowest = 1;
  for (const reading of readings) {
    if (parseAxisOcrCounter(reading.value) === null || reading.confidence === null
      || !Number.isFinite(reading.confidence) || reading.confidence < 0 || reading.confidence > 1) return null;
    lowest = Math.min(lowest, reading.confidence);
  }
  return Math.min(99, Math.floor(lowest * 100));
}

function normalizeAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().toLowerCase();
  return normalized || null;
}

/** Parse an OCR counter conservatively; malformed, negative, fractional, or oversized values abstain. */
export function parseAxisOcrCounter(value: unknown): number | null {
  if (value == null || value === "") return null;
  let count: number;
  if (typeof value === "number") count = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) count = Number(value.trim());
  else return null;
  return Number.isSafeInteger(count) && count >= 0 && count <= AXIS_KDA_MAX ? count : null;
}

/** Match only globally unique, exact aliases. Ambiguous OCR rows and roster names stay unassigned. */
export function matchAxisOcrRows(
  rows: readonly Pick<AxisOcrRow, "id" | "nickname">[],
  participants: readonly AxisOcrParticipant[],
): Record<string, string | null> {
  const output = Object.fromEntries(rows.map((row) => [row.id, null])) as Record<string, string | null>;
  const rowIdCounts = new Map<string, number>();
  const rowAliasCounts = new Map<string, number>();
  for (const row of rows) {
    rowIdCounts.set(row.id, (rowIdCounts.get(row.id) ?? 0) + 1);
    const alias = normalizeAlias(row.nickname);
    if (alias) rowAliasCounts.set(alias, (rowAliasCounts.get(alias) ?? 0) + 1);
  }

  const participantsByAlias = new Map<string, Set<string>>();
  for (const participant of participants) {
    if (typeof participant.discordId !== "string" || !participant.discordId) continue;
    for (const rawAlias of [participant.historyName, participant.arenaNickname]) {
      const alias = normalizeAlias(rawAlias);
      if (!alias) continue;
      const ids = participantsByAlias.get(alias) ?? new Set<string>();
      ids.add(participant.discordId);
      participantsByAlias.set(alias, ids);
    }
  }

  const candidateByRowId = new Map<string, string>();
  const candidateCounts = new Map<string, number>();
  for (const row of rows) {
    if (rowIdCounts.get(row.id) !== 1) continue;
    const alias = normalizeAlias(row.nickname);
    if (!alias || rowAliasCounts.get(alias) !== 1) continue;
    const ids = participantsByAlias.get(alias);
    if (ids?.size !== 1) continue;
    const discordId = ids.values().next().value;
    if (!discordId) continue;
    candidateByRowId.set(row.id, discordId);
    candidateCounts.set(discordId, (candidateCounts.get(discordId) ?? 0) + 1);
  }
  for (const [rowId, discordId] of candidateByRowId) {
    if (candidateCounts.get(discordId) === 1) output[rowId] = discordId;
  }
  return output;
}

function hasTwoByFiveRoster(participants: readonly AxisOcrParticipant[]): boolean {
  if (participants.length !== 10) return false;
  const counts = [0, 0];
  const ids = new Set<string>();
  for (const participant of participants) {
    if ((participant.teamIndex !== 0 && participant.teamIndex !== 1)
      || typeof participant.discordId !== "string" || !participant.discordId || ids.has(participant.discordId)) return false;
    ids.add(participant.discordId);
    counts[participant.teamIndex]++;
  }
  return counts[0] === 5 && counts[1] === 5;
}

/** Infer which roster team is shown on the left, requiring unambiguous roster shape and evidence. */
export function inferAxisOcrLeftTeam(
  rows: readonly Pick<AxisOcrRow, "id" | "side">[],
  assignments: Readonly<Record<string, string | null>>,
  participants: readonly AxisOcrParticipant[],
): 0 | 1 | null {
  if (!hasTwoByFiveRoster(participants)) return null;

  const teamById = new Map(participants.map((participant) => [participant.discordId, participant.teamIndex as 0 | 1]));
  const rowIds = new Set<string>();
  const assignedParticipants = new Set<string>();
  const membersBySide: Record<AxisOcrSide, Set<string>> = { left: new Set(), right: new Set() };
  const teamsBySide: Record<AxisOcrSide, Set<0 | 1>> = { left: new Set(), right: new Set() };
  for (const row of rows) {
    if ((row.side !== "left" && row.side !== "right") || rowIds.has(row.id)) return null;
    rowIds.add(row.id);
    const discordId = assignments[row.id];
    if (!discordId) continue;
    const team = teamById.get(discordId);
    if (team == null) continue;
    if (assignedParticipants.has(discordId)) return null;
    assignedParticipants.add(discordId);
    membersBySide[row.side].add(discordId);
    teamsBySide[row.side].add(team);
  }

  const leftTeams = teamsBySide.left, rightTeams = teamsBySide.right;
  if (leftTeams.size > 1 || rightTeams.size > 1) return null;
  if (leftTeams.size === 1 && rightTeams.size === 1) {
    const leftTeam = leftTeams.values().next().value!;
    const rightTeam = rightTeams.values().next().value!;
    if (leftTeam === rightTeam) return null;
    return leftTeam;
  }
  if (leftTeams.size === 1 && membersBySide.left.size >= 2) return leftTeams.values().next().value!;
  if (rightTeams.size === 1 && membersBySide.right.size >= 2) return rightTeams.values().next().value === 0 ? 1 : 0;
  return null;
}
