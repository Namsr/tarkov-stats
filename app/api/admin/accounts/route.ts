import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod } from "@/lib/admin/types";
import { isGameMode } from "@/types/seasonal";
import { getModerationForAids, getSuspiciousAids } from "@/lib/admin/moderation-db";

export const runtime = "nodejs";

const SOURCES = new Set(["upstream", "cache", "stored", "suspicious"]);

function validCursor(cursor: string | null): boolean {
  if (!cursor) return true;
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 2 && value.every(Number.isSafeInteger);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const params = request.nextUrl.searchParams;
  const period = parseAdminPeriod(params.get("period"));
  const domain = parseAdminDomain(params.get("domain"));
  const mode = params.get("mode");
  const source = params.get("source");
  const sort = params.get("sort") ?? "last";
  const cursor = params.get("cursor");
  const search = params.get("search")?.trim() ?? "";
  const rawLimit = params.get("limit");
  const limit = rawLimit == null ? 50 : Number(rawLimit);
  if (!period || !domain || (mode && !isGameMode(mode)) || (source && !SOURCES.has(source)) ||
      (sort !== "last" && sort !== "requests") || !validCursor(cursor) || search.length > 64 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  const store = await getAnalyticsStore();
  if (!store) return NextResponse.json({ accounts: [], nextCursor: null, available: false }, { headers: ADMIN_NO_STORE_HEADERS });
  const suspiciousOnly = source === "suspicious";
  const suspiciousAids = suspiciousOnly ? await getSuspiciousAids().catch(() => null) : undefined;
  if (suspiciousAids === null) {
    return NextResponse.json({ accounts: [], nextCursor: null, available: false }, { headers: ADMIN_NO_STORE_HEADERS });
  }
  const page = store.accounts({
    period, domain, mode, source: suspiciousOnly ? null : source, aids: suspiciousAids,
    sort, cursor, search, limit,
  });
  const moderation = await getModerationForAids(page.accounts.map((account) => account.aid)).catch(() => []);
  const byAid = new Map(moderation.map((item) => [item.aid, item]));
  return NextResponse.json({
    ...page,
    accounts: page.accounts.map((account) => {
      const item = byAid.get(account.aid);
      return {
        ...account,
        risk: item?.risk ?? null,
        reportCount: item?.sources.communityReports ?? 0,
        confirmedBan: item?.sources.confirmedBan ?? false,
        review: item?.review ?? { status: "new", note: null, updatedAt: null },
        canRestoreManualBan: item?.canRestoreManualBan ?? false,
      };
    }),
    available: true,
  }, { headers: ADMIN_NO_STORE_HEADERS });
}
