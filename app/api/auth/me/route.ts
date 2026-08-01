import { after, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isAdminUser } from "@/lib/admin-auth";
import { recordAuthActivity } from "@/lib/admin/request-events";

// Returns the current user (or null) for client components.
export async function GET() {
  const user = await getSession();
  if (user) after(() => recordAuthActivity(user.sub));
  return NextResponse.json(
    { user, isAdmin: isAdminUser(user) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
