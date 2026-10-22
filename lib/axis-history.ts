import { AXIS_SERVER_ID, axisAvatarUrl, type AxisProfile } from "./axis-league.ts";
import type { AxisSeason } from "./axis-seasons";
import type { AxisKda, AxisRoundScore } from "./axis-kda";
import type { AxisWinProbability } from "./axis-win-probability";

export const AXIS_HISTORY_SOURCE_URL = `https://www.neatqueue.com/history/${AXIS_SERVER_ID}`;
export const AXIS_HISTORY_API_URL = `https://api.neatqueue.com/api/v1/history/${AXIS_SERVER_ID}`;
export const AXIS_HISTORY_PAGE_SIZE = 25;
// Larger NeatQueue history pages time out from the VPS; keep imports within measured working sizes.
export const AXIS_ARCHIVE_PAGE_SIZE = 50;

export interface AxisMatchPlayer {
  kda?: AxisKda | null;
  id: string; name: string; avatarUrl?: string | null; mmr: number | null; change: number | null; profile: AxisProfile | null;
}
export interface AxisMatchEdit { name: string | null; at: number }
export interface AxisMatch {
  winProbability?: AxisWinProbability | null;
  edited?: AxisMatchEdit | null;
  rounds?: AxisRoundScore | null;
  queueId?: string | null;
  number: number; time: number | null; queue: string | null; maps: string[];
  teams: { name: string | null; players: AxisMatchPlayer[] }[];
  winner: number | null;
}
export interface AxisHistoryPage { matches: AxisMatch[]; page: number; pages: number; total: number }
/** Shared by the fetch planner and the atomic archive publisher. */
export function advanceAxisArchiveState(previous: { complete: number; next_page: number }, data: AxisHistoryPage, count: number) {
  const nextPage = previous.complete && count < data.total ? 2 : data.page === 1 ? previous.next_page : data.page + 1;
  return { complete: Number(count >= data.total), next_page: nextPage > data.pages ? 2 : nextPage };
}
export interface AxisHistorySummary {
  played: number;
  winsA: number;
  winsB: number;
  averageWinProbability: (AxisWinProbability & { matches: number }) | null;
  maps: { name: string; matches: number }[];
}
export interface AxisHistoryResponse extends AxisHistoryPage {
  map?: string;
  summary?: AxisHistorySummary;
  matchNumber?: number;
  updatedAt: number | null; available: boolean; stale: boolean;
  seasons?: AxisSeason[]; season?: string; archiveComplete?: boolean;
}

/** Rank saved results within a team; keep players without K/D/A in their source order. */
export function sortAxisMatchPlayers(players: readonly AxisMatchPlayer[], locale: string): AxisMatchPlayer[] {
  const names = new Intl.Collator(locale, { sensitivity: "base" });
  return [...players].sort((a, b) => {
    if (a.kda == null || b.kda == null) return Number(b.kda != null) - Number(a.kda != null);
    return b.kda.kills - a.kda.kills || a.kda.deaths - b.kda.deaths
      || b.kda.assists - a.kda.assists || names.compare(a.name, b.name);
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid match history object");
  return value as Record<string, unknown>;
}
function numeric(value: unknown, integer = false, min = -Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError("Invalid match history number");
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new TypeError("Invalid match history text");
  return value;
}

/** Keep only public match details, and validate the whole page before publishing it. */
export function parseAxisHistory(value: unknown, requestedPage: number, pageSize = AXIS_HISTORY_PAGE_SIZE): AxisHistoryPage {
  const body = object(value), pagination = object(body.pagination);
  const page = numeric(pagination.current_page, true, 1);
  const total = numeric(pagination.total_items, true, 0);
  const pages = Math.max(1, numeric(pagination.total_pages, true, 0));
  if (page !== requestedPage || pagination.per_page !== pageSize || pages !== Math.max(1, Math.ceil(total / pageSize)) || !Array.isArray(body.data)) {
    throw new TypeError("Unexpected match history pagination");
  }
  const matches = body.data.map((value): AxisMatch => {
    const row = object(value);
    if (row.guild_id !== AXIS_SERVER_ID || !Array.isArray(row.teams) || row.teams.length > 16) throw new TypeError("Unexpected match source");
    const time = row.time == null ? null : text(row.time);
    // NeatQueue stores naive UTC timestamps. Never interpret them in the server's local timezone.
    if (time != null && !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(time)) throw new TypeError("Invalid match time");
    const timestamp = time == null ? null : Date.parse(time.replace(" ", "T") + (/(?:Z|[+-]\d{2}:\d{2})$/.test(time) ? "" : "Z"));
    if (timestamp != null && !Number.isFinite(timestamp)) throw new TypeError("Invalid match time");
    const teams = row.teams.map((team, index) => {
      if (!Array.isArray(team) || team.length > 100) throw new TypeError("Invalid match team");
      return {
        name: Array.isArray(row.team_names) && row.team_names[index] != null ? text(row.team_names[index]) : null,
        players: team.map((value): AxisMatchPlayer => {
          const player = object(value);
          if (typeof player.id !== "string" || !/^\d{1,20}$/.test(player.id)) throw new TypeError("Invalid match player ID");
          return { id: player.id, name: text(player.name), avatarUrl: axisAvatarUrl(player.avatar_url), mmr: row.show_mmr === false || player.mmr == null ? null : numeric(player.mmr),
            change: row.show_mmr === false || player.mmr_change == null ? null : numeric(player.mmr_change), profile: null };
        }),
      };
    });
    const winner = row.winner == null ? null : numeric(row.winner, true, -2);
    if (winner != null && winner >= teams.length) throw new TypeError("Invalid winning team");
    const maps: string[] = [];
    if (row.matchdata != null) {
      if (!Array.isArray(row.matchdata)) throw new TypeError("Invalid match metadata");
      for (const field of row.matchdata) {
        if (Array.isArray(field) && field[0] === "Map" && Array.isArray(field[1])) maps.push(...field[1].map(text));
      }
    }
    const queueId = typeof row.queue_channel === "string" && /^\d{1,20}$/.test(row.queue_channel) ? row.queue_channel : null;
    return { number: numeric(row.game_num, true, 1), time: timestamp, queueId, queue: row.game == null ? null : text(row.game), maps, teams, winner };
  });
  const expected = Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize));
  if (matches.length !== expected || new Set(matches.map((match) => match.number)).size !== matches.length || matches.some((match, i) => i > 0 && match.number >= matches[i - 1].number)) {
    throw new TypeError("Incomplete or unordered match history");
  }
  return { matches, page, pages, total };
}
