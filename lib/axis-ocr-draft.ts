const fields = ["kills", "deaths", "assists"] as const;
type KdaField = typeof fields[number];
export type AxisOcrDraftKda = { discordId: string; kills: string; deaths: string; assists: string };
export type AxisOcrKdaCandidate = { discordId: string; kills: number | null; deaths: number | null; assists: number | null };
export type AxisOcrRoundDraft = { a: string; b: string };
export type AxisOcrRoundCandidate = { a: number | null; b: number | null };
export type AxisOcrTouchSnapshot = Record<string, number>;

export function axisOcrKdaTouchKey(discordId: string, field: KdaField): string {
  return `kda:${discordId}:${field}`;
}

export function axisOcrRoundTouchKey(side: "a" | "b"): string {
  return `rounds:${side}`;
}

function validText(value: string): boolean {
  if (!/^\d{1,4}$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 9999;
}

function validCandidate(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 9999;
}

function canFill(
  key: string,
  value: string,
  started: AxisOcrTouchSnapshot,
  current: AxisOcrTouchSnapshot,
): boolean {
  return value === "" && (started[key] ?? 0) === 0 && (started[key] ?? 0) === (current[key] ?? 0);
}

/** Merge only complete, valid K/D/A groups, preserving fields edited during recognition. */
export function fillAxisOcrKdaDrafts<T extends AxisOcrDraftKda>(
  drafts: readonly T[],
  candidates: readonly AxisOcrKdaCandidate[],
  started: AxisOcrTouchSnapshot,
  current: AxisOcrTouchSnapshot,
): { drafts: T[]; filled: number } {
  const candidateCounts = new Map<string, number>();
  for (const candidate of candidates) candidateCounts.set(candidate.discordId, (candidateCounts.get(candidate.discordId) ?? 0) + 1);
  const candidateById = new Map(candidates.map((candidate) => [candidate.discordId, candidate]));
  let filled = 0;
  const nextDrafts = drafts.map((draft) => {
    const candidate = candidateById.get(draft.discordId);
    if (!candidate || candidateCounts.get(draft.discordId) !== 1) return draft;
    const eligible = Object.fromEntries(fields.map((field) => [
      field,
      canFill(axisOcrKdaTouchKey(draft.discordId, field), draft[field], started, current)
        && validCandidate(candidate[field]),
    ])) as Record<KdaField, boolean>;
    if (!fields.some((field) => eligible[field])) return draft;
    const merged = Object.fromEntries(fields.map((field) => [
      field,
      eligible[field] ? String(candidate[field]) : draft[field],
    ])) as Record<KdaField, string>;
    if (!fields.every((field) => validText(merged[field]))) return draft;
    const updated = { ...draft } as T;
    for (const field of fields) {
      if (eligible[field]) {
        updated[field] = merged[field];
        filled++;
      }
    }
    return updated;
  });
  return { drafts: nextDrafts, filled };
}

/** Merge a round score only when the resulting pair is complete and valid. */
export function fillAxisOcrRoundDraft<T extends AxisOcrRoundDraft>(
  draft: T | null,
  candidate: AxisOcrRoundCandidate | null,
  started: AxisOcrTouchSnapshot,
  current: AxisOcrTouchSnapshot,
): { draft: T | null; filled: number } {
  if (!draft || !candidate) return { draft, filled: 0 };
  const eligible = {
    a: canFill(axisOcrRoundTouchKey("a"), draft.a, started, current) && validCandidate(candidate.a),
    b: canFill(axisOcrRoundTouchKey("b"), draft.b, started, current) && validCandidate(candidate.b),
  };
  if (!eligible.a && !eligible.b) return { draft, filled: 0 };
  const merged = {
    a: eligible.a ? String(candidate.a) : draft.a,
    b: eligible.b ? String(candidate.b) : draft.b,
  };
  if (!validText(merged.a) || !validText(merged.b)) return { draft, filled: 0 };
  return { draft: { ...draft, ...merged } as T, filled: Number(eligible.a) + Number(eligible.b) };
}
