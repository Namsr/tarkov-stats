import { AXIS_SERVER_ID, type AxisProfile } from "./axis-league.ts";

export const AXIS_HISTORY_SOURCE_URL = `https://www.neatqueue.com/history/${AXIS_SERVER_ID}`;
export const AXIS_HISTORY_API_URL = `https://api.neatqueue.com/api/v1/history/${AXIS_SERVER_ID}`;
export const AXIS_HISTORY_PAGE_SIZE = 25;

export interface AxisMatchPlayer {
  id: string; name: string; mmr: number | null; change: number | null; profile: AxisProfile | null;
}
export interface AxisMatch {
  number: number; time: number | null; queue: string | null; maps: string[];
  teams: { name: string | null; players: AxisMatchPlayer[] }[];
  winner: number | null;
}
export interface AxisHistoryPage { matches: AxisMatch[]; page: number; pages: number; total: number }
export interface AxisHistoryResponse extends AxisHistoryPage {
  updatedAt: number | null; available: boolean; stale: boolean;
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
export function parseAxisHistory(value: unknown, requestedPage: number): AxisHistoryPage {
  const body = object(value), pagination = object(body.pagination);
  const page = numeric(pagination.current_page, true, 1);
  const total = numeric(pagination.total_items, true, 0);
  const pages = Math.max(1, numeric(pagination.total_pages, true, 0));
  if (page !== requestedPage || pagination.per_page !== AXIS_HISTORY_PAGE_SIZE || pages !== Math.max(1, Math.ceil(total / AXIS_HISTORY_PAGE_SIZE)) || !Array.isArray(body.data)) {
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
          return { id: player.id, name: text(player.name), mmr: row.show_mmr === false || player.mmr == null ? null : numeric(player.mmr),
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
    return { number: numeric(row.game_num, true, 1), time: timestamp, queue: row.game == null ? null : text(row.game), maps, teams, winner };
  });
  const expected = Math.max(0, Math.min(AXIS_HISTORY_PAGE_SIZE, total - (page - 1) * AXIS_HISTORY_PAGE_SIZE));
  if (matches.length !== expected || new Set(matches.map((match) => match.number)).size !== matches.length || matches.some((match, i) => i > 0 && match.number >= matches[i - 1].number)) {
    throw new TypeError("Incomplete or unordered match history");
  }
  return { matches, page, pages, total };
}
