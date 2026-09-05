import { NextRequest, NextResponse } from "next/server";
import type { LeaderboardErrorResponse } from "@/types/leaderboard";
import { leaderboardRuntime, parseLeaderboardRequest, prepareLeaderboardCandidate } from "@/lib/leaderboard/runtime";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  let parsed: ReturnType<typeof parseLeaderboardRequest>;
  try {
    parsed = parseLeaderboardRequest(request.nextUrl.searchParams);
  } catch (error) {
    return NextResponse.json<LeaderboardErrorResponse>({ code: "invalid_leaderboard_request",
      error: error instanceof Error ? error.message : "Invalid leaderboard request" }, { status: 400, headers: noStore });
  }
  const runtime = await leaderboardRuntime(parsed.config);
  if (!runtime) return NextResponse.json<LeaderboardErrorResponse>({ code: "leaderboard_unavailable",
    error: "Leaderboard has not been published" }, { status: 503, headers: { ...noStore, "Retry-After": "300" } });
  let prepared;
  let response;
  try {
    prepared = parsed.aid == null ? null : await prepareLeaderboardCandidate(runtime.reader, parsed.config, parsed.aid);
    response = runtime.reader.readPage(parsed.config, parsed.sort, parsed.aid, parsed.aid == null ? 500 : 100,
      prepared?.candidate, Date.now(), prepared?.generation, prepared?.generatedAt);
  } catch (error) {
    console.warn("leaderboard read failed: " + (error instanceof Error ? error.message : String(error)));
    return NextResponse.json<LeaderboardErrorResponse>({ code: "leaderboard_unavailable",
      error: "Leaderboard is temporarily unavailable" }, { status: 503, headers: { ...noStore, "Retry-After": "300" } });
  }
  if (!response) return NextResponse.json<LeaderboardErrorResponse>({ code: "leaderboard_unavailable",
    error: "Leaderboard has not been published" }, { status: 503, headers: { ...noStore, "Retry-After": "300" } });
  if (parsed.aid != null && !response.subject) return NextResponse.json<LeaderboardErrorResponse>({
    code: "leaderboard_subject_not_found", error: "Player is not present in this leaderboard",
  }, { status: 404, headers: noStore });
  return NextResponse.json(response, { headers: noStore });
}
