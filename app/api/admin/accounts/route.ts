import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod } from "@/lib/admin/types";
import { isGameMode } from "@/types/seasonal";
import { getCommunityReportsStore, type CommunityReview } from "@/lib/community-reports-db";
import { getModerationForAids, getSnapshotCountsForAids } from "@/lib/admin/moderation-db";
import { getStore, type CrossSectionMode, type PlayerStore } from "@/lib/db";
import { getSeasonalStore } from "@/lib/seasonal/storage";

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

async function storedReportNicknames(
  reports: readonly CommunityReview[],
  knownNicknames: ReadonlyMap<number, string | null>,
): Promise<Map<number, string>> {
  const missing = reports.filter((report) => !knownNicknames.get(report.aid));
  const modes = [...new Set(missing.flatMap((report) => [report.mode, ...report.modes]).filter(isGameMode))];
  const crossSectionModes = modes.filter((item): item is CrossSectionMode => item !== "seasonal");
  const stores = new Map<CrossSectionMode, PlayerStore | null>(await Promise.all(
    crossSectionModes.map(async (item) => [item, await getStore(item)] as const),
  ));
  const seasonalStore = modes.includes("seasonal") ? await getSeasonalStore() : null;
  const resolved = await Promise.all(missing.map(async (report) => {
    const reportModes = [...new Set([report.mode, ...report.modes].filter(isGameMode))];
    for (const reportMode of reportModes) {
      if (reportMode === "seasonal") {
        // Per-mode cycle: the latest report overall may be regular/arena while an
        // earlier seasonal report holds a different cycleId. Use the latest seasonal
        // cycleId so seasonal nicknames resolve even when seasonal is not last.
        const seasonalCycleId = report.seasonalCycleId ?? (report.mode === "seasonal" ? report.cycleId : null);
        if (!seasonalCycleId) continue;
        const nickname = (await seasonalStore?.getProfile({ mode: "seasonal", cycleId: seasonalCycleId, aid: report.aid }))?.nickname;
        if (nickname) return [report.aid, nickname] as const;
        continue;
      }
      const nickname = (await stores.get(reportMode)?.profileSummary(report.aid))?.nickname;
      if (nickname) return [report.aid, nickname] as const;
    }
    return null;
  }));
  return new Map(resolved.filter((item): item is readonly [number, string] => item !== null));
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
      (sort !== "last" && sort !== "requests" && sort !== "snapshots") || !validCursor(cursor) || search.length > 64 ||
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
  const snapshotCounts = new Map<number, number>();
  for (let offset = 0; offset < moderationAids.length; offset += MAX_SQLITE_AIDS) {
    const aids = moderationAids.slice(offset, offset + MAX_SQLITE_AIDS);
    const batch = await getModerationForAids(aids).catch(() => []);
    moderation.push(...batch);
    const counts = await getSnapshotCountsForAids(aids, mode).catch(() => new Map<number, number>());
    for (const [aid, count] of counts) snapshotCounts.set(aid, count);
  }
  const byAid = new Map(moderation.map((item) => [item.aid, item]));
  const accountByAid = new Map(page.accounts.map((account) => [account.aid, account]));
  // Precedence (ban-wins): a confirmed global ban keeps the account visible even
  // when a false_positive review exists. False positives only hide pending rows.
  // Perf: stored nickname enrichment runs strictly after all filters + slice, so
  // with limit<=100 we issue at most ~limit*modes stored reads instead of scanning
  // the whole reviews() table (reportAids up to ~900, reviews() unbounded).
  // Tradeoff: `search` matches analytics nicknames + AID before enrichment;
  // stored-only nicknames are display enrichment and not part of the search index.
  const filteredSuspicious = suspiciousOnly
    ? reportRows
      .filter((report) => !mode || report.modes.includes(mode))
      .map((report) => {
        const account = accountByAid.get(report.aid);
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
            snapshotCount: snapshotCounts.get(report.aid) ?? 0,
          }),
          nickname: account?.nickname ?? null,
          modes: [...new Set([...(account?.modes ?? []), ...report.modes, report.mode])],
          snapshotCount: snapshotCounts.get(report.aid) ?? account?.snapshotCount ?? 0,
          reportedAt: report.lastReportedAt,
          reportedMode: report.mode,
          reportedModes: report.modes,
          risk: item?.risk ?? null,
          reportCount: report.reportCount,
          confirmedBan: item?.sources.confirmedBan ?? false,
          review: item?.review ?? { status: "new", note: null, updatedAt: null },
          canRestoreManualBan: item?.canRestoreManualBan ?? false,
        };
      })
      .filter((account) => account.confirmedBan || account.review.status !== "false_positive")
      .filter((account) => !search || account.nickname?.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || String(account.aid) === search)
      .sort((left, right) => sort === "requests"
        ? right.reportCount - left.reportCount || right.reportedAt - left.reportedAt || right.aid - left.aid
        : sort === "snapshots"
          ? right.snapshotCount - left.snapshotCount || right.reportedAt - left.reportedAt || right.aid - left.aid
          : right.reportedAt - left.reportedAt || right.aid - left.aid)
    : [];
  const pageSlice = suspiciousOnly ? filteredSuspicious.slice(0, limit) : [];
  const pageReports = suspiciousOnly
    ? pageSlice.map((account) => reportByAid.get(account.aid)).filter((item): item is CommunityReview => item !== undefined)
    : [];
  const storedNicknames = suspiciousOnly
    ? await storedReportNicknames(pageReports, new Map(page.accounts.map((account) => [account.aid, account.nickname])))
    : new Map<number, string>();
  const accounts = suspiciousOnly
    ? pageSlice.map((account) => ({
        ...account,
        nickname: account.nickname ?? storedNicknames.get(account.aid) ?? null,
      }))
    : page.accounts.map((account) => {
      const item = byAid.get(account.aid);
      const report = reportByAid.get(account.aid);
      return {
        ...account,
        snapshotCount: snapshotCounts.get(account.aid) ?? account.snapshotCount,
        risk: item?.risk ?? null,
        reportCount: report?.reportCount ?? item?.sources.communityReports ?? 0,
        reportedMode: report?.mode,
        reportedModes: report?.modes ?? [],
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
