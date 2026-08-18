import { requireAdmin } from "@/lib/admin-auth";
import {
  getDataAuditStore,
  runDataAudit,
} from "@/lib/admin/data-audit";
import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";

export const runtime = "nodejs";

export async function GET() {
  const access = await requireAdmin();
  if (!access.ok) {
    return Response.json(
      { error: "admin_access_denied" },
      { status: access.status, headers: ADMIN_NO_STORE_HEADERS },
    );
  }
  const store = await getDataAuditStore();
  if (!store) {
    return Response.json(
      { available: false, running: false, snapshot: null, error: "storage_unavailable" },
      { headers: ADMIN_NO_STORE_HEADERS },
    );
  }
  return Response.json(store.read(), { headers: ADMIN_NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request);
  if (rejected) return rejected;
  const store = await getDataAuditStore();
  if (!store) {
    return Response.json(
      { error: "storage_unavailable", available: false, running: false, snapshot: null },
      { status: 503, headers: ADMIN_NO_STORE_HEADERS },
    );
  }
  try {
    const result = await runDataAudit({ store });
    if (!result.started) {
      return Response.json(result.state, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
    }
    return Response.json(result.state, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    console.error("admin data audit failed", error);
    return Response.json(
      { error: "audit_failed", available: true, running: false, snapshot: null },
      { status: 503, headers: ADMIN_NO_STORE_HEADERS },
    );
  }
}
