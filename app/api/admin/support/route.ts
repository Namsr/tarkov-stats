import { NextResponse } from "next/server";
import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/types";
import { rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { requireAdmin } from "@/lib/admin-auth";
import { getSupportStore, type NotificationLevel } from "@/lib/admin/support-db";

export const runtime = "nodejs";

export async function GET() {
  const access = await requireAdmin();
  if (!access.ok) {
    return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  }
  const store = await getSupportStore();
  if (!store) {
    return NextResponse.json({ notifications: [], goals: [], available: false }, { headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    return NextResponse.json(
      { notifications: store.listNotifications(), goals: store.listGoals(), available: true },
      { headers: ADMIN_NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("admin support read failed", error);
    return NextResponse.json({ error: "Support content failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

type Action =
  | "create_notification"
  | "update_notification"
  | "set_notification_active"
  | "delete_notification"
  | "create_goal"
  | "update_goal"
  | "set_goal_active"
  | "delete_goal";

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request);
  if (rejected) return rejected;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad();
  const action = body.action as Action | undefined;
  const store = await getSupportStore();
  if (!store) return NextResponse.json({ error: "Support content failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  try {
    switch (action) {
      case "create_notification": {
        if (typeof body.title !== "string" || typeof body.body !== "string") return bad();
        if (body.href != null && typeof body.href !== "string") return bad();
        if (body.level != null && typeof body.level !== "string") return bad();
        const notification = store.createNotification({
          title: body.title,
          body: body.body,
          href: (body.href as string | null | undefined) ?? null,
          level: body.level as NotificationLevel | undefined,
        });
        return ok({ notification, notifications: store.listNotifications() });
      }
      case "update_notification": {
        if (!Number.isSafeInteger(body.id)) return bad();
        if (body.title !== undefined && typeof body.title !== "string") return bad();
        if (body.body !== undefined && typeof body.body !== "string") return bad();
        if (body.href !== undefined && body.href !== null && typeof body.href !== "string") return bad();
        if (body.level !== undefined && typeof body.level !== "string") return bad();
        const patch: { title?: string; body?: string; href?: string | null; level?: NotificationLevel } = {};
        if (body.title !== undefined) patch.title = body.title as string;
        if (body.body !== undefined) patch.body = body.body as string;
        if (body.href !== undefined) patch.href = body.href as string | null;
        if (body.level !== undefined) patch.level = body.level as NotificationLevel;
        const notification = store.updateNotification(Number(body.id), patch);
        return ok({ notification, notifications: store.listNotifications() });
      }
      case "set_notification_active": {
        if (!Number.isSafeInteger(body.id) || typeof body.active !== "boolean") return bad();
        return ok({ notifications: store.setNotificationActive(Number(body.id), body.active) });
      }
      case "delete_notification": {
        if (!Number.isSafeInteger(body.id)) return bad();
        return ok({ notifications: store.deleteNotification(Number(body.id)) });
      }
      case "create_goal": {
        if (typeof body.collectedRub !== "number" || typeof body.goalRub !== "number") return bad();
        const goal = store.createGoal({
          collectedRub: body.collectedRub,
          goalRub: body.goalRub,
          usdRate: typeof body.usdRate === "number" ? body.usdRate : 1,
        });
        return ok({ goal, goals: store.listGoals() });
      }
      case "update_goal": {
        if (!Number.isSafeInteger(body.id)) return bad();
        for (const field of ["collectedRub", "goalRub", "usdRate"]) {
          if (body[field] !== undefined && typeof body[field] !== "number") return bad();
        }
        const patch: { collectedRub?: number; goalRub?: number; usdRate?: number } = {};
        if (body.collectedRub !== undefined) patch.collectedRub = body.collectedRub as number;
        if (body.goalRub !== undefined) patch.goalRub = body.goalRub as number;
        if (body.usdRate !== undefined) patch.usdRate = body.usdRate as number;
        const goal = store.updateGoal(Number(body.id), patch);
        return ok({ goal, goals: store.listGoals() });
      }
      case "set_goal_active": {
        if (!Number.isSafeInteger(body.id)) return bad();
        return ok({ goals: store.setGoalActive(Number(body.id)) });
      }
      case "delete_goal": {
        if (!Number.isSafeInteger(body.id)) return bad();
        return ok({ goals: store.deleteGoal(Number(body.id)) });
      }
      default:
        return bad();
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    }
    console.error("admin support write failed", error);
    return NextResponse.json({ error: "Support content failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

function ok(body: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...body }, { headers: ADMIN_NO_STORE_HEADERS });
}

function bad() {
  return NextResponse.json({ error: "Invalid support request" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
}
