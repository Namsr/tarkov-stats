import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import {
  LATENCY_PROBES,
  LATENCY_SCAN_DEFAULT_SAMPLES,
  LATENCY_SCAN_DEFAULT_TIMEOUT_MS,
  LATENCY_SCAN_MAX_SAMPLES,
  LATENCY_SCAN_MAX_TIMEOUT_MS,
  LATENCY_SCAN_MIN_SAMPLES,
  LATENCY_SCAN_MIN_TIMEOUT_MS,
  LATENCY_SCAN_SCHEMA,
  runLatencyScan,
} from "@/lib/admin/latency-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) {
    return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  }
  return NextResponse.json({
    schema: LATENCY_SCAN_SCHEMA,
    available: true,
    defaults: { samples: LATENCY_SCAN_DEFAULT_SAMPLES, timeoutMs: LATENCY_SCAN_DEFAULT_TIMEOUT_MS },
    limits: {
      samples: { min: LATENCY_SCAN_MIN_SAMPLES, max: LATENCY_SCAN_MAX_SAMPLES },
      timeoutMs: { min: LATENCY_SCAN_MIN_TIMEOUT_MS, max: LATENCY_SCAN_MAX_TIMEOUT_MS },
    },
    targets: LATENCY_PROBES,
    usage: "POST with JSON body { samples?, timeoutMs? } to run the scan.",
  }, { headers: ADMIN_NO_STORE_HEADERS });
}

export async function POST(request: NextRequest) {
  const rejected = await rejectInvalidAdminMutation(request);
  if (rejected) return rejected;
  let body: { samples?: unknown; timeoutMs?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  try {
    const host = request.headers.get("x-forwarded-host") ?? request.nextUrl.host ?? null;
    const result = await runLatencyScan({ samples: body.samples, timeoutMs: body.timeoutMs, host });
    return NextResponse.json(result, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    console.error("admin latency scan failed", error);
    return NextResponse.json(
      { error: "latency_scan_failed" },
      { status: 503, headers: ADMIN_NO_STORE_HEADERS },
    );
  }
}
