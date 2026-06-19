import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";

function num(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function GET(request: NextRequest) {
  const store = await getStore();
  if (!store) {
    return NextResponse.json({ total: 0, averages: null, brackets: [] });
  }

  const min = num(request.nextUrl.searchParams.get("minHours"));
  const max = num(request.nextUrl.searchParams.get("maxHours"));

  try {
    const [averages, brackets] = await Promise.all([
      store.averages(min, max),
      store.distribution(),
    ]);
    const total = brackets.reduce((sum, b) => sum + b.n, 0);
    return NextResponse.json(
      { total, averages, brackets },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (e) {
    console.error("average stats failed", e);
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
