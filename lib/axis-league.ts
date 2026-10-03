import type { GameMode } from "../types/seasonal";
import { parsePlayerInput } from "./player-id.ts";

export const AXIS_REFRESH_MS = 5 * 60_000;
export const AXIS_SERVER_ID = "1343726035136413716";
export const AXIS_CHANNEL_ID = "1343726040421367842";
export const AXIS_SOURCE_URL = `https://www.neatqueue.com/leaderboard/${AXIS_SERVER_ID}/${AXIS_CHANNEL_ID}?display=players`;
export const AXIS_API_URL = `https://api.neatqueue.com/api/v2/leaderboard/${AXIS_SERVER_ID}/${AXIS_CHANNEL_ID}`;

export interface AxisProfile { aid: number; mode: GameMode }
export interface AxisPlayer {
  id: string;
  name: string;
  position: number;
  mmr: number;
  peakMmr: number | null;
  games: number;
  wins: number;
  losses: number;
  winrate: number;
  streak: number;
  peakStreak: number | null;
  profile: AxisProfile | null;
}
export interface AxisLeagueResponse {
  players: AxisPlayer[];
  updatedAt: number | null;
  stale: boolean;
  available: boolean;
}
export type AxisSort = "position" | "mmr" | "peakMmr" | "games" | "wins" | "losses" | "winrate" | "streak" | "peakStreak";
export const AXIS_SORTS: AxisSort[] = ["position", "mmr", "peakMmr", "games", "wins", "losses", "winrate", "streak", "peakStreak"];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid leaderboard object");
  return value as Record<string, unknown>;
}
function number(value: unknown, integer = false, minimum = -Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError("Invalid leaderboard statistic");
  }
  return value;
}

/** Reject an incomplete page before it can replace the last successful snapshot. */
export function parseAxisPage(value: unknown): { players: AxisPlayer[]; total: number; pages: number } {
  const body = record(value);
  if (body.server_id !== AXIS_SERVER_ID || body.channel_id !== AXIS_CHANNEL_ID || body.display !== "players") {
    throw new TypeError("Unexpected leaderboard source");
  }
  if (!Array.isArray(body.months) || body.months.length !== 1) throw new TypeError("Invalid leaderboard periods");
  const month = record(body.months[0]);
  if (month.month !== "alltime" || !Array.isArray(month.data)) throw new TypeError("Invalid leaderboard period");
  const pagination = record(month.pagination);
  const total = number(pagination.total_items, true, 0);
  const pages = Math.max(1, number(pagination.total_pages, true, 0));
  const players = month.data.map((value): AxisPlayer => {
    const row = record(value);
    const stats = record(row.stats);
    if (typeof row.id !== "string" || !/^\d{1,20}$/.test(row.id) || typeof row.name !== "string" || !row.name.trim() || row.name.length > 200) {
      throw new TypeError("Invalid leaderboard player");
    }
    const winrate = number(stats.winrate, false, 0);
    if (winrate > 1) throw new TypeError("Invalid winrate");
    return {
      id: row.id, name: row.name, position: number(stats.current_rank, true, 1),
      mmr: number(stats.mmr), peakMmr: stats.peak_mmr == null ? null : number(stats.peak_mmr),
      games: number(stats.totalgames, true, 0), wins: number(stats.wins, true, 0), losses: number(stats.losses, true, 0),
      winrate, streak: number(stats.streak, true),
      peakStreak: stats.peak_streak == null ? null : number(stats.peak_streak, true, 0), profile: null,
    };
  });
  return { players, total, pages };
}

/** Store identity only; pasted URLs never become public link destinations. */
export function parseAxisProfile(input: string): AxisProfile | null {
  const text = input.trim();
  if (/^\d{1,15}$/.test(text)) {
    const parsed = parsePlayerInput(text);
    return parsed ? { aid: parsed.aid, mode: "arena" } : null;
  }
  let url: URL;
  try { url = new URL(text, "https://tarkovstats.ru"); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  const ownHosts = ["tarkovstats.ru", "www.tarkovstats.ru", "tarkovstats.online", "www.tarkovstats.online", "localhost", "127.0.0.1"];
  if (ownHosts.includes(url.hostname)) {
    const match = url.pathname.match(/^\/player\/(regular|pve|arena|pvp-season)\/(\d{1,15})\/?$/);
    if (!match) return null;
    const aid = parsePlayerInput(match[2])?.aid;
    return aid ? { aid, mode: match[1] === "pvp-season" ? "seasonal" : match[1] as GameMode } : null;
  }
  if (!["tarkov.dev", "www.tarkov.dev"].includes(url.hostname) || !/^\/players\/(regular|pve|arena|pvp-season)\/\d{1,15}\/?$/.test(url.pathname)) return null;
  return parsePlayerInput(url.pathname);
}

export function axisProfileHref(profile: AxisProfile): string {
  return `/player/${profile.mode === "seasonal" ? "pvp-season" : profile.mode}/${profile.aid}`;
}

export function sortAxisPlayers(players: AxisPlayer[], sort: AxisSort, direction: "asc" | "desc"): AxisPlayer[] {
  return [...players].sort((a, b) => {
    const left = a[sort], right = b[sort];
    if (left == null && right != null) return 1;
    if (right == null && left != null) return -1;
    return (left != null && right != null ? (left - right) * (direction === "asc" ? 1 : -1) : 0)
      || a.position - b.position || a.id.localeCompare(b.id);
  });
}
