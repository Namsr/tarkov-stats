import { NextRequest, NextResponse } from "next/server";
import {
  getPlayerIndexStore,
  type PersistentPlayerIndexMode,
  type PlayerIndexResult,
} from "@/lib/db";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { groupPlayerSearchResults, type PlayerSearchIndexMatch } from "@/lib/player-search";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { getSeasonalPlayerIndexStore } from "@/lib/seasonal/search-index";
import type { GameMode } from "@/types/seasonal";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;
const SEARCH_LIMIT = 12;
const SEARCH_MODES = ["regular", "pve", "arena", "seasonal"] as const;
type SearchMode = GameMode | "all";

function searchMode(value: string | null): SearchMode | null {
  if (value === null || value === "all") return "all";
  return SEARCH_MODES.includes(value as GameMode) ? value as GameMode : null;
}

async function searchPersistentMode(
  mode: PersistentPlayerIndexMode,
  nickname: string,
): Promise<{ available: boolean; matches: PlayerSearchIndexMatch[] }> {
  const index = await getPlayerIndexStore(mode);
  if (!index || !(await index.isReady())) return { available: false, matches: [] };
  const rows = await index.search(nickname, SEARCH_LIMIT);
  return {
    available: true,
    matches: rows.map((row: PlayerIndexResult) => ({
      aid: row.aid,
      name: row.name,
      mode,
      cycleId: "persistent",
      updatedAt: row.updatedAt,
    })),
  };
}

async function searchSeasonalMode(
  nickname: string,
): Promise<{ available: boolean; matches: PlayerSearchIndexMatch[] }> {
  const cycle = loadSeasonalCycleConfig();
  if (!cycle || !isSeasonalRolloutReady()) return { available: false, matches: [] };
  const index = await getSeasonalPlayerIndexStore(cycle.cycleId);
  if (!index || !(await index.isReady())) return { available: false, matches: [] };
  const rows = await index.search(nickname, SEARCH_LIMIT);
  return {
    available: true,
    matches: rows.map((row) => ({
      aid: row.aid,
      name: row.name,
      mode: "seasonal",
      cycleId: cycle.cycleId,
      updatedAt: row.updatedAt,
    })),
  };
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  });
  const ip = getClientIp(request);

  const { allowed, headers } = getRateLimitHeaders(ip, { bucket: "search" });
  if (!allowed) {
    timing.finish({ operation: "player_search", outcome: "rate_limited", status: 429 });
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers }
    );
  }

  const names = request.nextUrl.searchParams.getAll("name");
  const modes = request.nextUrl.searchParams.getAll("mode");
  const name = names[0]?.trim();
  const mode = searchMode(modes[0] ?? null);
  if (names.length !== 1 || modes.length > 1 || !name || !NICKNAME_RE.test(name) || !mode) {
    timing.finish({ operation: "player_search", outcome: "invalid", status: 400 });
    return NextResponse.json(
      { error: "Invalid nickname. Use alphanumeric characters, dashes, or underscores (1-15 chars)." },
      { status: 400, headers }
    );
  }

  try {
    const requestedModes = mode === "all" ? [...SEARCH_MODES] : [mode];
    const settled = await Promise.allSettled(requestedModes.map((requestedMode) =>
      requestedMode === "seasonal"
        ? searchSeasonalMode(name)
        : searchPersistentMode(requestedMode, name)
    ));
    const available = settled.flatMap((result) =>
      result.status === "fulfilled" && result.value.available ? [result.value] : []
    );
    if (available.length === 0) {
      timing.finish({ operation: "player_search", outcome: "unavailable", status: 503 });
      return NextResponse.json(
        { error: "Player nickname index is not ready" },
        { status: 503, headers }
      );
    }
    const results = groupPlayerSearchResults(
      available.flatMap((result) => result.matches),
      name,
      SEARCH_LIMIT,
    );
    const exact = results.find((player) =>
      player.profiles.some((profile) => profile.name.trim().toLowerCase() === name.toLowerCase())
    );
    timing.setRequestContext({ aid: exact?.aid, nickname: exact?.name ?? null });
    timing.finish({
      operation: "player_search",
      mode: mode === "all" ? undefined : mode,
      outcome: results.length ? "success" : "not_found",
      status: 200,
      source: "index",
    });
    return NextResponse.json(results, { headers });
  } catch {
    timing.finish({ operation: "player_search", outcome: "error", status: 502 });
    return NextResponse.json(
      { error: "Failed to search players" },
      { status: 502, headers }
    );
  }
}
