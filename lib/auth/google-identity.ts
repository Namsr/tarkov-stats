import type { SessionUser } from "./session";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";

/** Names come only from Google or a verified session; never publish an email fallback. */
export function googleDisplayName(user: SessionUser): string | null {
  const name = user.name?.trim();
  return name && name !== user.email && name.length <= 200 ? name : null;
}

export async function recordGoogleIdentity(user: SessionUser): Promise<void> {
  try {
    (await getAxisLeagueStore()).rememberGoogleAccount(user.sub, googleDisplayName(user));
  } catch {
    // A directory failure must not prevent sign-in or reading the current session.
    console.warn("Google display name could not be saved");
  }
}
