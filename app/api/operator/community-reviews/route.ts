import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { getCommunityReportsStore } from "@/lib/community-reports-db";
import { parsePlayerId } from "@/lib/player-id";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!await isOperatorRequest(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const rawAid = new URL(request.url).searchParams.get("aid");
  const aid = rawAid === null ? undefined : parsePlayerId(rawAid);
  if (aid === null) return Response.json({ error: "Invalid account ID" }, { status: 400, headers });
  const store = await getCommunityReportsStore();
  if (!store) return Response.json({ error: "Storage unavailable" }, { status: 503, headers });
  const reviews = await store.reviews(aid);
  return Response.json({ reviews: reviews.map(({ aid: accountId, reportCount, yesCount, noCount, lastReportedAt }) => ({ aid: accountId, reportCount, yesCount, noCount, lastReportedAt })) }, { headers });
}
