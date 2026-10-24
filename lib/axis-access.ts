import "server-only";
import { getSession, type SessionUser } from "@/lib/auth/session";
import { isAdminUser, type AdminAccess } from "@/lib/admin-auth";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import type { AxisUploadRole } from "@/lib/axis-match-submission";

export async function canEditAxisKda(user: SessionUser | null): Promise<boolean> {
  return (await axisUploadRole(user)) === "moderator";
}

/** Allows AXIS match statistics and league profile links, never the dashboard or role assignment. */
export async function requireAxisKdaEditor(): Promise<AdminAccess> {
  const user = await getSession();
  if (!user) return { ok: false, status: 401 };
  return await canEditAxisKda(user) ? { ok: true, user } : { ok: false, status: 403 };
}

/** A player can submit a screenshot; a moderator can submit and review it. */
export async function axisUploadRole(user: SessionUser | null): Promise<AxisUploadRole | null> {
  if (!user) return null;
  const subject = user.sub;
  if (isAdminUser(user)) return "moderator";
  try { return (await getAxisLeagueStore()).readAxisRole(subject); }
  catch { return null; }
}

export async function canSubmitAxisScreenshot(user: SessionUser | null): Promise<boolean> {
  return (await axisUploadRole(user)) !== null;
}

export async function canModerateAxisMatches(user: SessionUser | null): Promise<boolean> {
  return canEditAxisKda(user);
}

export async function requireAxisScreenshotSubmitter(): Promise<AdminAccess> {
  const user = await getSession();
  if (!user) return { ok: false, status: 401 };
  return await canSubmitAxisScreenshot(user) ? { ok: true, user } : { ok: false, status: 403 };
}

export async function requireAxisModerator(): Promise<AdminAccess> {
  const user = await getSession();
  if (!user) return { ok: false, status: 401 };
  return await canModerateAxisMatches(user) ? { ok: true, user } : { ok: false, status: 403 };
}
