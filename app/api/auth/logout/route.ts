import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

// Clear the session cookie. Client reloads after calling this.
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
