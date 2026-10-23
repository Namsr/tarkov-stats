import { NextResponse } from "next/server";
import { getPublicIndexCoverage } from "@/lib/public-index-coverage";
import { getPublicBanCounter } from "@/lib/public-ban-counter";

export const runtime = "nodejs";

const PUBLIC_CACHE = { "Cache-Control": "public, max-age=60, s-maxage=60" };

export async function GET() {
  try {
    const [coverage, banned] = await Promise.all([getPublicIndexCoverage(), getPublicBanCounter()]);
    return NextResponse.json({ ...coverage, banned }, { headers: PUBLIC_CACHE });
  } catch (error) {
    console.warn("public coverage read failed", error);
    return NextResponse.json({ total: null, syncedAt: null, banned: null }, { headers: PUBLIC_CACHE });
  }
}
