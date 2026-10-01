import { NextResponse } from "next/server";
import { getPublicIndexCoverage } from "@/lib/public-index-coverage";

export const runtime = "nodejs";

/** Public coverage counters, no per-user data: one policy for every branch so a
 *  fallback cannot ship without Cache-Control and become heuristically cached.
 *  The number is written by `sync-player-index.mjs` at swap time, so this is a
 *  single indexed key lookup against `player_index_meta`. */
const PUBLIC_CACHE = { "Cache-Control": "public, max-age=300, s-maxage=600" };

export async function GET() {
  try {
    const coverage = await getPublicIndexCoverage();
    return NextResponse.json(coverage, { headers: PUBLIC_CACHE });
  } catch (error) {
    console.warn("public index coverage read failed", error);
    return NextResponse.json({ total: null, syncedAt: null }, { headers: PUBLIC_CACHE });
  }
}