import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AxisMatch } from "./axis-history";
import { AXIS_PREDICTION_VERSION, type AxisWinProbability } from "./axis-win-probability.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

// Matches originate from the validated archive. Only model inputs are sent;
// names, profile payloads and any unknown metadata remain owned by the store.
function project(match: AxisMatch) {
  return {
    number: match.number, time: match.time, queueId: match.queueId, queue: match.queue,
    maps: match.maps, winner: match.winner, rounds: match.rounds,
    teams: match.teams.map(team => ({ players: team.players.map(player => {
      const kda = player.kda;
      return { id: player.id, mmr: Number.isFinite(player.mmr) ? player.mmr : null,
        change: Number.isFinite(player.change) ? player.change : null,
        kda: kda && [kda.kills, kda.deaths, kda.assists].every(n => Number.isFinite(n) && n >= 0) ? kda : null };
    }) })),
  };
}
function eligible(match: AxisMatch): boolean {
  if (match.time == null || !Number.isFinite(match.time) || match.teams.length !== 2 || !match.teams[0].players.length ||
    match.teams[0].players.length !== match.teams[1].players.length || match.teams[0].players.length > 10) return false;
  const ids = match.teams.flatMap(team => team.players.map(player => player.id));
  return ids.every(id => typeof id === "string" && /^\d{1,20}$/.test(id)) && new Set(ids).size === ids.length;
}

/** Pure child computation; the caller retains its existing SQLite transaction. */
export function buildNativeAxisProbabilities(matches: readonly AxisMatch[]): Map<number, AxisWinProbability> {
  const parts = ['{"matches":['];
  let bytes = Buffer.byteLength(parts[0]) + 2;
  for (const match of matches) {
    const part = JSON.stringify(project(match));
    bytes += Buffer.byteLength(part) + Number(parts.length > 1);
    if (bytes > MAX_BYTES) throw new Error("Axis native prediction input exceeds 8 MiB");
    if (parts.length > 1) parts.push(",");
    parts.push(part);
  }
  parts.push("]}");
  const input = parts.join("");
  const binary = process.env.AXIS_PREDICTION_BIN || resolve("rust/axis-probability/target/release", `axis-probability${process.platform === "win32" ? ".exe" : ""}`);
  const result = spawnSync(binary, [], { input, encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_BYTES });
  if (result.error || result.status !== 0) throw new Error("Axis native prediction worker failed", { cause: result.error });
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch { throw new Error("Invalid Axis native prediction response"); }
  if (!response || typeof response !== "object" || !("version" in response) || response.version !== AXIS_PREDICTION_VERSION ||
    !("predictions" in response) || !Array.isArray(response.predictions)) throw new Error("Invalid Axis native prediction response");
  const expected = new Set(matches.filter(eligible).map(match => match.number));
  const predictions = new Map<number, AxisWinProbability>();
  for (const row of response.predictions) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "number" || !Number.isSafeInteger(row[0]) ||
      !expected.has(row[0]) || predictions.has(row[0]) || !row[1] || typeof row[1] !== "object") throw new Error("Invalid Axis native prediction response");
    const { a, b } = row[1];
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b) ||
      a < 0.05 || a > 0.95 || b < 0.05 || b > 0.95 || Math.abs(a + b - 1) > 1e-12 ||
      Math.abs(a * 1000 - Math.round(a * 1000)) > 1e-9 || Math.abs(b * 1000 - Math.round(b * 1000)) > 1e-9) throw new Error("Invalid Axis native prediction response");
    predictions.set(row[0], { a, b });
  }
  if (predictions.size !== expected.size) throw new Error("Incomplete Axis native prediction response");
  return predictions;
}
