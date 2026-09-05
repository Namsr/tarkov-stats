import { NextRequest, NextResponse } from "next/server";
import type { LeaderboardErrorResponse } from "@/types/leaderboard";
import { leaderboardRuntime, parseLeaderboardRequest, prepareLeaderboardCandidate } from "@/lib/leaderboard/runtime";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  let parsed: ReturnType<typeof parseLeaderboardRequest>;
  try {
    parsed = parseLeaderboardRequest(request.nextUrl.searchParams);
    if (parsed.aid == null) throw new Error("aid is required");
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
    prepared = await prepareLeaderboardCandidate(runtime.reader, parsed.config, parsed.aid!);
    response = prepared ? runtime.reader.readRank(parsed.config, parsed.aid!, prepared.candidate,
      Date.now(), prepared.generation, prepared.generatedAt) : null;
  } catch (error) {
    console.warn("leaderboard rank read failed: " + (error instanceof Error ? error.message : String(error)));
    return NextResponse.json<LeaderboardErrorResponse>({ code: "leaderboard_unavailable",
      error: "Leaderboard is temporarily unavailable" }, { status: 503, headers: { ...noStore, "Retry-After": "300" } });
  }
  if (!prepared) return NextResponse.json<LeaderboardErrorResponse>({ code: "leaderboard_unavailable",
    error: "Leaderboard has not been published" }, { status: 503, headers: { ...noStore, "Retry-After": "300" } });
  if (!response && !runtime.reader.snapshot(parsed.config, Date.now(), prepared.generation, prepared.generatedAt)) {
    return NextResponse.json<LeaderboardErrorResponse>({ code: "leaderboard_unavailable",
      error: "Leaderboard is temporarily unavailable" }, { status: 503, headers: { ...noStore, "Retry-After": "300" } });
  }
  if (!response) return NextResponse.json<LeaderboardErrorResponse>({ code: "leaderboard_subject_not_found",
    error: "Player is not present in this leaderboard" }, { status: 404, headers: noStore });
  return NextResponse.json(response, { headers: noStore });
}
