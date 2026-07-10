import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { resolveY, DEFAULT_Y } from "@/lib/metrics";
import { buildHistogram, MAX_HISTOGRAM_BINS } from "@/lib/histogram";

function num(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function binCount(v: string | null): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0
    ? Math.max(1, Math.min(MAX_HISTOGRAM_BINS, Math.floor(n)))
    : MAX_HISTOGRAM_BINS;
}

export async function GET(request: NextRequest) {
  const store = await getStore();
  if (!store) {
    return NextResponse.json({
      total: 0,
      averages: null,
      brackets: [],
      histogram: [],
      metric: DEFAULT_Y,
    });
  }

  const min = num(request.nextUrl.searchParams.get("minHours"));
  const max = num(request.nextUrl.searchParams.get("maxHours"));
  const maxBins = binCount(request.nextUrl.searchParams.get("maxBins"));
  const metric = resolveY(request.nextUrl.searchParams.get("metric"));

  try {
    const [averages, brackets] = await Promise.all([
      store.averages(min, max),
      store.bracketAggregate(metric.agg === "avg" ? metric.column! : null),
    ]);
    const total = brackets.reduce((s, b) => s + b.n, 0);
    let histogram = buildHistogram(brackets, maxBins);
    if (metric.agg === "avg" && metric.column) {
      const values = await store.histogramAverages(metric.column, histogram);
      histogram = histogram.map((bin, i) => ({ ...bin, avg: values[i] ?? null }));
    }
    return NextResponse.json(
      { total, averages, brackets, histogram, metric: metric.key },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (e) {
    console.error("average stats failed", e);
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
