export interface AxisKda { kills: number; deaths: number; assists: number }
export interface AxisKdaChange { discordId: string; kda: AxisKda | null; expected: AxisKda | null }
export interface AxisRoundScore { a: number; b: number }
export interface AxisRoundChange { score: AxisRoundScore | null; expected: AxisRoundScore | null }
export const AXIS_KDA_MAX = 9999;

export function parseAxisKda(value: unknown): AxisKda | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid KDA");
  const row = value as Record<string, unknown>;
  for (const key of ["kills", "deaths", "assists"]) {
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > AXIS_KDA_MAX) throw new TypeError("Invalid KDA counter");
  }
  return { kills: row.kills as number, deaths: row.deaths as number, assists: row.assists as number };
}

export function sameAxisKda(left: AxisKda | null, right: AxisKda | null): boolean {
  return left === null || right === null ? left === right : left.kills === right.kills && left.deaths === right.deaths && left.assists === right.assists;
}

export function parseAxisKdaChanges(value: unknown): AxisKdaChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1600) throw new TypeError("Invalid KDA changes");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.discordId !== "string" || !/^\d{1,20}$/.test(entry.discordId) || ids.has(entry.discordId)) throw new TypeError("Invalid player");
    ids.add(entry.discordId);
    return { discordId: entry.discordId, kda: parseAxisKda(entry.kda), expected: parseAxisKda(entry.expected) };
  });
}

export class AxisKdaConflict extends Error {}

export function parseAxisRoundScore(value: unknown): AxisRoundScore | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid round score");
  const row = value as Record<string, unknown>;
  for (const key of ["a", "b"]) {
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > AXIS_KDA_MAX) throw new TypeError("Invalid round counter");
  }
  return { a: row.a as number, b: row.b as number };
}

export function sameAxisRoundScore(left: AxisRoundScore | null, right: AxisRoundScore | null): boolean {
  return left === null || right === null ? left === right : left.a === right.a && left.b === right.b;
}

export function parseAxisRoundChange(value: unknown): AxisRoundChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid round change");
  const row = value as Record<string, unknown>;
  return { score: parseAxisRoundScore(row.score), expected: parseAxisRoundScore(row.expected) };
}
