import { NextResponse } from "next/server";
import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/types";
import { rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { requireAdmin } from "@/lib/admin-auth";
import { getShowcaseStore } from "@/lib/admin/showcase-db";

export const runtime = "nodejs";

export async function GET() {
  const access = await requireAdmin();
  if (!access.ok) {
    return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  }
  const store = await getShowcaseStore();
  if (!store) return NextResponse.json({ groups: [], available: false }, { headers: ADMIN_NO_STORE_HEADERS });
  try {
    return NextResponse.json({ groups: store.listGroups(), available: true }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    console.error("admin showcase read failed", error);
    return NextResponse.json({ error: "Showcase failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

type Action =
  | "create_group"
  | "rename_group"
  | "delete_group"
  | "set_active"
  | "add_item"
  | "remove_item"
  | "update_item"
  | "reorder";

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request);
  if (rejected) return rejected;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad();
  const action = body.action as Action | undefined;
  const store = await getShowcaseStore();
  if (!store) return NextResponse.json({ error: "Showcase failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  try {
    switch (action) {
      case "create_group": {
        if (typeof body.name !== "string") return bad();
        const group = store.createGroup(body.name);
        return ok({ group, groups: store.listGroups() });
      }
      case "rename_group": {
        if (!Number.isSafeInteger(body.id) || typeof body.name !== "string") return bad();
        const group = store.renameGroup(Number(body.id), body.name as string);
        return ok({ group, groups: store.listGroups() });
      }
      case "delete_group": {
        if (!Number.isSafeInteger(body.id)) return bad();
        store.deleteGroup(Number(body.id));
        return ok({ groups: store.listGroups() });
      }
      case "set_active": {
        if (!Number.isSafeInteger(body.id)) return bad();
        return ok({ groups: store.setActive(Number(body.id)) });
      }
      case "add_item": {
        if (!Number.isSafeInteger(body.groupId) || !Number.isSafeInteger(body.aid)) return bad();
        if (body.nickname != null && typeof body.nickname !== "string") return bad();
        const group = store.addItem(Number(body.groupId), Number(body.aid), (body.nickname as string | null | undefined) ?? null);
        return ok({ group, groups: store.listGroups() });
      }
      case "remove_item": {
        if (!Number.isSafeInteger(body.groupId) || !Number.isSafeInteger(body.aid)) return bad();
        const group = store.removeItem(Number(body.groupId), Number(body.aid));
        return ok({ group, groups: store.listGroups() });
      }
      case "update_item": {
        if (!Number.isSafeInteger(body.groupId) || !Number.isSafeInteger(body.aid)) return bad();
        const patch: { enabled?: boolean; nickname?: string | null } = {};
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== "boolean") return bad();
          patch.enabled = body.enabled;
        }
        if (body?.nickname !== undefined) {
          if (body.nickname !== null && typeof body.nickname !== "string") return bad();
          patch.nickname = body.nickname as string | null;
        }
        const group = store.updateItem(Number(body.groupId), Number(body.aid), patch);
        return ok({ group, groups: store.listGroups() });
      }
      case "reorder": {
        if (!Number.isSafeInteger(body.groupId) || !Array.isArray(body.aids)) return bad();
        const group = store.reorder(Number(body.groupId), (body.aids as unknown[]).map(Number));
        return ok({ group, groups: store.listGroups() });
      }
      default:
        return bad();
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    }
    console.error("admin showcase write failed", error);
    return NextResponse.json({ error: "Showcase failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

function ok(body: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...body }, { headers: ADMIN_NO_STORE_HEADERS });
}

function bad() {
  return NextResponse.json({ error: "Invalid showcase request" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
}
