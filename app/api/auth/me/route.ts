import { after, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isAdminUser } from "@/lib/admin-auth";
import { recordAuthActivity } from "@/lib/admin/request-events";
import { recordGoogleIdentity } from "@/lib/auth/google-identity";
import { axisUploadRole } from "@/lib/axis-access";

export const runtime = "nodejs";

// Returns the current user (or null) for client components.
export async function GET() {
  const user = await getSession();
  if (user) {
    after(async () => {
      await recordGoogleIdentity(user);
      await recordAuthActivity(user.sub);
    });
  }
  const role = await axisUploadRole(user);
  return NextResponse.json(
    { user, isAdmin: isAdminUser(user), canEditAxisKda: role === "moderator", canSubmitAxisScreenshot: role !== null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
