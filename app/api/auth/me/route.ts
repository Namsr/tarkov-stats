import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

// Returns the current user (or null) for client components.
export async function GET() {
  const user = await getSession();
  return NextResponse.json(
    { user },
    { headers: { "Cache-Control": "no-store" } }
  );
}
