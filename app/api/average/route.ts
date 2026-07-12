import { NextRequest, NextResponse } from "next/server";
import { getStore, type BucketAgg, type RangeDimension } from "@/lib/db";
import { resolveY, DEFAULT_Y } from "@/lib/metrics";

function parseNonNegative(v: string | null): { value: number | null; valid: boolean } {
  if (v == null || v === "") return { value: null, valid: true };
  const value = Number(v);
  return { value: Number.isFinite(value) && value >= 0 ? value : null, valid: Number.isFinite(value) && value >= 0 };
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

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const dimension = parseDimension(params.get("dimension"));
  if (!dimension) {
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }

  const usesNewRange = params.has("dimension") || params.has("min") || params.has("max");
  const parsedMin = parseNonNegative(params.get(usesNewRange ? "min" : "minHours"));
  const parsedMax = parseNonNegative(params.get(usesNewRange ? "max" : "maxHours"));
  if (!parsedMin.valid || !parsedMax.valid) {
    return NextResponse.json({ error: "Range values must be finite and non-negative" }, { status: 400 });
  }
  if (parsedMin.value != null && parsedMax.value != null && parsedMin.value > parsedMax.value) {
    return NextResponse.json({ error: "Range minimum cannot exceed maximum" }, { status: 400 });
  }

  const metric = resolveY(params.get("metric"));
  const store = await getStore();
  if (!store) {
    return NextResponse.json({
      total: 0,
      averages: null,
      brackets: [],
      buckets: [],
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
    return NextResponse.json(
      {
        total,
        averages,
        brackets: legacyBrackets(buckets),
        buckets,
        bounds,
        dimension,
        metric: metric.key,
      },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (error) {
    console.error("average stats failed", error);
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
