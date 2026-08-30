import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getSystemMetricsStore, parseSystemMetricSample } from "@/lib/admin/system-metrics";
import { ADMIN_NO_STORE_HEADERS, parseAdminPeriod } from "@/lib/admin/types";

export const runtime = "nodejs";

function validCollectorToken(request: NextRequest, expected: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const period = parseAdminPeriod(request.nextUrl.searchParams.get("period"));
  if (!period) return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const store = await getSystemMetricsStore();
  if (!store) return NextResponse.json({ available: false, configured: Boolean(process.env.SYSTEM_METRICS_INGEST_TOKEN), reason: "storage_unavailable", latest: null, points: [] }, { headers: ADMIN_NO_STORE_HEADERS });
  return NextResponse.json({
    available: true,
    configured: Boolean(process.env.SYSTEM_METRICS_INGEST_TOKEN),
    ...store.range(period),
  }, { headers: ADMIN_NO_STORE_HEADERS });
}

export async function POST(request: NextRequest) {
  const expected = process.env.SYSTEM_METRICS_INGEST_TOKEN?.trim() ?? "";
  if (!expected) return NextResponse.json({ error: "collector_not_configured" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  if (!validCollectorToken(request, expected)) return NextResponse.json({ error: "collector_access_denied" }, { status: 401, headers: ADMIN_NO_STORE_HEADERS });

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS }); }
  const sample = parseSystemMetricSample(body);
  if (!sample) return NextResponse.json({ error: "invalid_sample" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const store = await getSystemMetricsStore();
  if (!store) return NextResponse.json({ error: "storage_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  store.record(sample);
  return new NextResponse(null, { status: 204, headers: ADMIN_NO_STORE_HEADERS });
}
