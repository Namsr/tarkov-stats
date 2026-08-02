import { requireAdmin } from "@/lib/admin-auth";
import { isValidMutationOrigin } from "@/lib/admin/origin";

export const ADMIN_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
};

export async function rejectInvalidAdminMutation(request: Request): Promise<Response | null> {
  const auth = await requireAdmin();
  if (!auth.ok) {
    return Response.json(
      { error: auth.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: auth.status, headers: ADMIN_NO_STORE_HEADERS }
    );
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return Response.json(
      { error: "Content-Type must be application/json" },
      { status: 415, headers: ADMIN_NO_STORE_HEADERS }
    );
  }
  if (!isValidMutationOrigin(request)) {
    return Response.json(
      { error: "Invalid origin" },
      { status: 403, headers: ADMIN_NO_STORE_HEADERS }
    );
  }
  return null;
}

export function parseConfirmedAid(body: unknown): { aid: number } | null {
  if (!body || typeof body !== "object") return null;
  const input = body as { aid?: unknown; confirmAid?: unknown };
  if (!Number.isSafeInteger(input.aid) || Number(input.aid) <= 0 || input.confirmAid !== input.aid) {
    return null;
  }
  return { aid: Number(input.aid) };
}
