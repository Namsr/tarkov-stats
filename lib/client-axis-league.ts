import { AXIS_REFRESH_MS, type AxisLeagueResponse } from "./axis-league.ts";

// One public snapshot survives client navigation without retaining session/access data.
let snapshot: AxisLeagueResponse | null = null;
let receivedAt = 0;
const listeners = new Set<() => void>();

export function getCachedAxisLeague(): AxisLeagueResponse | null { return snapshot; }
export function getServerAxisLeague(): null { return null; }
export function subscribeAxisLeague(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function cacheAxisLeague(data: AxisLeagueResponse): void {
  if (!data.available || !Array.isArray(data.players)) throw new Error("Leaderboard unavailable");
  if (snapshot === data) return;
  snapshot = data;
  receivedAt = Date.now();
  for (const listener of listeners) listener();
}

export function axisLeagueRefreshDelay(now = Date.now()): number {
  return snapshot ? Math.max(0, AXIS_REFRESH_MS - (now - receivedAt)) : 0;
}

export async function loadClientAxisLeague(signal: AbortSignal, force = false): Promise<void> {
  signal.throwIfAborted();
  if (!force && axisLeagueRefreshDelay() > 0) return;
  const previous = snapshot;
  const response = await fetch("/api/axis-league", { cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  const body = await response.json() as AxisLeagueResponse;
  signal.throwIfAborted();
  if (!response.ok || !body?.available || !Array.isArray(body.players)) throw new Error("Leaderboard unavailable");
  // A profile edit made during this read takes precedence over its older response.
  if (snapshot === previous) cacheAxisLeague(body);
}
