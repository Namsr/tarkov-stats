import "server-only";
import { getSession, type SessionUser } from "@/lib/auth/session";

export type AdminAccess =
  | { ok: true; user: SessionUser }
  | { ok: false; status: 401 | 403 };

/** Admin access is tied to the stable Google subject, never email or display name. */
export function isAdminUser(user: SessionUser | null | undefined): user is SessionUser {
  const adminSub = process.env.ADMIN_GOOGLE_SUB;
  return Boolean(adminSub && user?.sub === adminSub);
}

export async function getAdminSession(): Promise<SessionUser | null> {
  const user = await getSession();
  return isAdminUser(user) ? user : null;
}

/** Distinguishes a missing session (401) from a signed-in non-admin (403). */
export async function requireAdmin(): Promise<AdminAccess> {
  const user = await getSession();
  if (!user) return { ok: false, status: 401 };
  return isAdminUser(user)
    ? { ok: true, user }
    : { ok: false, status: 403 };
}
