import { NextRequest, NextResponse } from "next/server";
import { getStore, type BucketAgg, type RangeDimension } from "@/lib/db";
import { buildNumericHistogram, MAX_HISTOGRAM_BINS } from "@/lib/histogram";
import { DEFAULT_Y, resolveY } from "@/lib/metrics";
import { isGameMode } from "@/types/seasonal";

function parseNonNegative(value: string | null): { value: number | null; valid: boolean } {
  if (value == null || value === "") return { value: null, valid: true };
  const number = Number(value);
  const valid = Number.isFinite(number) && number >= 0;
  return { value: valid ? number : null, valid };
}

function parseDimension(value: string | null): RangeDimension | null {
  if (value == null || value === "hours") return "hours";
  if (value === "pmc_raids") return "pmc_raids";
  return null;
}

function legacyBrackets(buckets: BucketAgg[]) {
  return buckets.map((bucket) => ({
    bracket_key: bucket.hi == null ? `${bucket.lo}+` : `${bucket.lo}-${bucket.hi}`,
    n: bucket.n,
    sum: bucket.sum,
  }));
}

function binCount(value: string | null): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.min(MAX_HISTOGRAM_BINS, Math.floor(number)))
    : MAX_HISTOGRAM_BINS;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const rawMode = params.get("mode") ?? "regular";
  if (!isGameMode(rawMode) || rawMode === "seasonal") {
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  const dimension = parseDimension(params.get("dimension"));
  if (!dimension) {
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }

  // New min/max ranges are inclusive. Legacy minHours/maxHours preserve their
  // previous exclusive upper-bound behavior for existing consumers.
  const usesNewRange = params.has("dimension") || params.has("min") || params.has("max");
  const parsedMin = parseNonNegative(params.get(usesNewRange ? "min" : "minHours"));
  const parsedMax = parseNonNegative(params.get(usesNewRange ? "max" : "maxHours"));
  if (!parsedMin.valid || !parsedMax.valid) {
    return NextResponse.json(
      { error: "Range values must be finite and non-negative" },
      { status: 400 },
    );
  }
  if (parsedMin.value != null && parsedMax.value != null && parsedMin.value > parsedMax.value) {
    return NextResponse.json({ error: "Range minimum cannot exceed maximum" }, { status: 400 });
  }

  const metric = resolveY(params.get("metric"));
  const maxBins = binCount(params.get("maxBins"));
  const store = await getStore(rawMode);
  if (!store) {
    return NextResponse.json({
      total: 0,
      averages: null,
      brackets: [],
      buckets: [],
      histogram: [],
      bounds: { min: 0, max: dimension === "hours" ? 5000 : 1000 },
      dimension,
      metric: metric.key || DEFAULT_Y,
    });
  }

  try {
    const [averages, buckets, bounds] = await Promise.all([
      store.averages({
        dimension,
        min: parsedMin.value,
        max: parsedMax.value,
        maxInclusive: usesNewRange,
      }),
      store.bucketAggregate(dimension, metric.agg === "avg" ? metric.column! : null),
      store.rangeBounds(dimension),
    ]);
    const total = buckets.reduce((sum, bucket) => sum + bucket.n, 0);
    const histogram = buildNumericHistogram(buckets, maxBins).map((bin) => ({
      ...bin,
      avg: metric.agg === "avg" && bin.n > 0 ? bin.sum / bin.n : null,
    }));

    return NextResponse.json(
      {
        total,
        averages,
        brackets: legacyBrackets(buckets),
        buckets,
        histogram,
        bounds,
        dimension,
        metric: metric.key,
      },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  } catch (error) {
    console.error("average stats failed", error);
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
