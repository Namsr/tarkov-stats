import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { resolveY, DEFAULT_Y } from "@/lib/metrics";

function num(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function GET(request: NextRequest) {
  const store = await getStore();
  if (!store) {
    return NextResponse.json({ total: 0, averages: null, brackets: [], metric: DEFAULT_Y });
  }

  const min = num(request.nextUrl.searchParams.get("minHours"));
  const max = num(request.nextUrl.searchParams.get("maxHours"));
  const metric = resolveY(request.nextUrl.searchParams.get("metric"));

  try {
    const [averages, brackets] = await Promise.all([
      store.averages(min, max),
      store.bracketAggregate(metric.agg === "avg" ? metric.column! : null),
    ]);
    const total = brackets.reduce((s, b) => s + b.n, 0);
    return NextResponse.json(
      { total, averages, brackets, metric: metric.key },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (e) {
    console.error("average stats failed", e);
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
