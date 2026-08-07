import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod } from "@/lib/admin/types";
import { isGameMode } from "@/types/seasonal";
import { getCommunityReportsStore } from "@/lib/community-reports-db";
import { getModerationForAids } from "@/lib/admin/moderation-db";

export const runtime = "nodejs";

const SOURCES = new Set(["upstream", "cache", "stored", "suspicious"]);
const MAX_SQLITE_AIDS = 900;

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
  const reports = suspiciousOnly
    ? await getCommunityReportsStore().then((reportsStore) => reportsStore?.reviews() ?? []).catch(() => null)
    : await getCommunityReportsStore().then((reportsStore) => reportsStore?.reviews() ?? []).catch(() => []);
  if (suspiciousOnly && reports === null) {
    return NextResponse.json({ accounts: [], nextCursor: null, available: false }, { headers: ADMIN_NO_STORE_HEADERS });
  }

  const reportRows = reports ?? [];
  const reportByAid = new Map(reportRows.map((item) => [item.aid, item]));
  const reportAids = [...reportByAid.keys()];
  const page = suspiciousOnly
    ? {
        accounts: store.accounts({
          period: "90d", domain: "all", mode, aids: reportAids.slice(0, MAX_SQLITE_AIDS), sort, limit: 100,
        }).accounts,
        nextCursor: null,
      }
    : store.accounts({
        period, domain, mode, source, sort, cursor, search, limit,
      });
  const moderationAids = [...new Set(suspiciousOnly ? reportAids : page.accounts.map((account) => account.aid))];
  const moderation: Awaited<ReturnType<typeof getModerationForAids>> = [];
  for (let offset = 0; offset < moderationAids.length; offset += MAX_SQLITE_AIDS) {
    const batch = await getModerationForAids(moderationAids.slice(offset, offset + MAX_SQLITE_AIDS)).catch(() => []);
    moderation.push(...batch);
  }
  const byAid = new Map(moderation.map((item) => [item.aid, item]));
  const accounts = suspiciousOnly
    ? reportRows
      .filter((report) => !mode || report.mode === mode)
      .map((report) => {
        const account = page.accounts.find((item) => item.aid === report.aid);
        const item = byAid.get(report.aid);
        return {
          ...(account ?? {
            aid: report.aid,
            nickname: null,
            modes: [report.mode],
            requestCount: 0,
            lastRequestedAt: report.lastReportedAt,
            outcomes: {},
            refreshCount: 0,
            sources: [],
          }),
          modes: [...new Set([...(account?.modes ?? []), report.mode])],
          reportedAt: report.lastReportedAt,
          risk: item?.risk ?? null,
          reportCount: report.reportCount,
          confirmedBan: item?.sources.confirmedBan ?? false,
          review: item?.review ?? { status: "new", note: null, updatedAt: null },
          canRestoreManualBan: item?.canRestoreManualBan ?? false,
        };
      })
      .filter((account) => !search || account.nickname?.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || String(account.aid) === search)
      .sort((left, right) => sort === "requests"
        ? right.reportCount - left.reportCount || right.reportedAt - left.reportedAt || right.aid - left.aid
        : right.reportedAt - left.reportedAt || right.aid - left.aid)
      .slice(0, limit)
    : page.accounts.map((account) => {
      const item = byAid.get(account.aid);
      const report = reportByAid.get(account.aid);
      return {
        ...account,
        risk: item?.risk ?? null,
        reportCount: report?.reportCount ?? item?.sources.communityReports ?? 0,
        confirmedBan: item?.sources.confirmedBan ?? false,
        review: item?.review ?? { status: "new", note: null, updatedAt: null },
        canRestoreManualBan: item?.canRestoreManualBan ?? false,
      };
    });
  return NextResponse.json({
    nextCursor: page.nextCursor,
    accounts,
    available: true,
  }, { headers: ADMIN_NO_STORE_HEADERS });
}
