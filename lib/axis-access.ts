import "server-only";
import { getSession, type SessionUser } from "@/lib/auth/session";
import { isAdminUser, type AdminAccess } from "@/lib/admin-auth";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";

export async function canEditAxisKda(user: SessionUser | null): Promise<boolean> {
  if (!user) return false;
  const subject = user.sub;
  if (isAdminUser(user)) return true;
  try { return (await getAxisLeagueStore()).isKdaEditor(subject); }
  catch { return false; }
}

/** This permission never grants access to the dashboard, profiles or role assignment. */
export async function requireAxisKdaEditor(): Promise<AdminAccess> {
  const user = await getSession();
  if (!user) return { ok: false, status: 401 };
  return await canEditAxisKda(user) ? { ok: true, user } : { ok: false, status: 403 };
}
