import { NextResponse } from "next/server";
import { getPublicIndexCoverage } from "@/lib/public-index-coverage";
import { getPublicBanCount } from "@/lib/public-ban-counter";
import { getPublicHomeCounter } from "@/lib/public-home-counter";

export const runtime = "nodejs";

const PUBLIC_CACHE = { "Cache-Control": "public, max-age=60, s-maxage=60" };

export async function GET() {
  try {
    const [coverage, counter, banned] = await Promise.all([getPublicIndexCoverage(), getPublicHomeCounter(), getPublicBanCount()]);
    return NextResponse.json({ ...coverage, counter, banned }, { headers: PUBLIC_CACHE });
  } catch (error) {
    console.warn("public coverage read failed", error);
    return NextResponse.json({ total: null, syncedAt: null, counter: null, banned: null }, { headers: PUBLIC_CACHE });
  }
}
