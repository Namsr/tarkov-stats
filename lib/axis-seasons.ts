import { AXIS_CHANNEL_ID } from "./axis-league.ts";
import type { AxisMatch } from "./axis-history";

export const AXIS_CURRENT_SEASON_START = Date.parse("2026-10-16T01:59:00+03:00");
export interface AxisSeason {
  id: string; startsAt: number; endsAt: number | null; firstMatch: number;
  inferred: boolean; current: boolean; matches: number;
}

/** A returning player's 1000 MMR alone can be a normal rating. Require a broad reset. */
export function detectAxisSeasons(matches: AxisMatch[]): AxisSeason[] {
  const ordered = matches.filter((match) => match.queueId === AXIS_CHANNEL_ID && match.time != null)
    .sort((a, b) => a.number - b.number);
  const seasons: AxisSeason[] = [];
  const ratings = new Map<string, number>();
  for (const match of ordered) {
    const players = match.teams.flatMap((team) => team.players).filter((player) => player.mmr != null);
    const known = players.filter((player) => ratings.has(player.id));
    const resets = known.filter((player) => player.mmr === 1000 && Math.abs(ratings.get(player.id)! - 1000) > 1);
    const last = seasons.at(-1);
    const confirmed = match.time! >= AXIS_CURRENT_SEASON_START && (!last || last.startsAt < AXIS_CURRENT_SEASON_START);
    if (!last || confirmed || match.winner != null && match.winner >= 0 && resets.length >= 6 && resets.length >= known.length * .75) {
      const startsAt = confirmed ? AXIS_CURRENT_SEASON_START : match.time!;
      if (last) last.endsAt = startsAt;
      seasons.push({ id: `match-${match.number}`, startsAt, endsAt: null,
        firstMatch: match.number, inferred: !confirmed, current: false, matches: 0 });
      ratings.clear();
    }
    seasons.at(-1)!.matches++;
    if (match.winner != null && match.winner >= 0) {
      for (const player of players) if (player.change != null) ratings.set(player.id, player.mmr! + player.change);
    }
  }
  if (!seasons.length || seasons.at(-1)!.startsAt < AXIS_CURRENT_SEASON_START) {
    if (seasons.length) seasons.at(-1)!.endsAt = AXIS_CURRENT_SEASON_START;
    seasons.push({ id: "current", startsAt: AXIS_CURRENT_SEASON_START, endsAt: null,
      firstMatch: (ordered.at(-1)?.number ?? 0) + 1, inferred: false, current: true, matches: 0 });
  }
  seasons.at(-1)!.id = "current";
  seasons.at(-1)!.current = true;
  return seasons.reverse();
}

export function axisSeasonMatches(matches: AxisMatch[], season: AxisSeason): AxisMatch[] {
  return matches.filter((match) => match.queueId === AXIS_CHANNEL_ID && match.time != null && match.time >= season.startsAt && (season.endsAt == null || match.time < season.endsAt));
}
