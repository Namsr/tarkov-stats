import { getSession } from "@/lib/auth/session";
import { getSupportStore } from "@/lib/admin/support-db";
import { readReportReplies, userNotificationFeed } from "@/lib/notifications";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { isValidMutationOrigin } from "@/lib/admin/origin";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

async function handle(request: NextRequest, markRead: boolean) {
  const { allowed } = getRateLimitHeaders(getClientIp(request), { bucket: "notifications", max: 60 });
  if (!allowed) return Response.json({ error: "Rate limit exceeded" }, { status: 429, headers });
  const user = await getSession();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (markRead && !isValidMutationOrigin(request)) {
    return Response.json({ error: "Invalid origin" }, { status: 403, headers });
  }
  let ids: string[] | null = null;
  if (markRead) {
    const body: unknown = await request.json().catch(() => null);
    const values = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).ids : null;
    if (!Array.isArray(values) || values.length === 0 || values.length > 120 ||
        !values.every((id: unknown) => typeof id === "string" && /^(news|report):[1-9]\d{0,15}$/.test(id))) {
      return Response.json({ error: "Invalid notification IDs" }, { status: 400, headers });
    }
    ids = [...new Set(values as string[])];
  }
  try {
    const store = await getSupportStore();
    if (!store) throw new Error("Storage unavailable");
    const feed = userNotificationFeed(store, user.sub, await readReportReplies(user.sub));
    if (ids) {
      const visible = new Set(feed.map((item) => item.id));
      if (!ids.every((id) => visible.has(id))) {
        return Response.json({ error: "Notification not found" }, { status: 404, headers });
      }
      store.markNotificationsRead(user.sub, ids);
      const marked = new Set(ids);
      for (const item of feed) if (marked.has(item.id)) item.read = true;
    }
    return Response.json({ notifications: feed, unreadCount: feed.filter((item) => !item.read).length }, { headers });
  } catch (error) {
    console.warn("notifications unavailable", error);
    return Response.json({ error: "Storage unavailable" }, { status: 503, headers });
  }
}

export async function GET(request: NextRequest) { return handle(request, false); }
export async function PATCH(request: NextRequest) { return handle(request, true); }
