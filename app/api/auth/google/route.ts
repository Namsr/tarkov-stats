import { NextRequest, NextResponse } from "next/server";
import { buildAuthUrl, callbackUrl } from "@/lib/auth/google";
import { sessionCookieOptions } from "@/lib/auth/session";

const STATE_COOKIE = "oauth_state";

// Start the Google login flow: stash a CSRF state value, then redirect to Google.
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const state = crypto.randomUUID();

  let authUrl: string;
  try {
    authUrl = buildAuthUrl(callbackUrl(origin), state);
  } catch {
    // Google credentials not configured yet — fail gracefully instead of 500.
    const home = new URL("/", origin);
    home.searchParams.set("auth_error", "not_configured");
    return NextResponse.redirect(home);
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, state, sessionCookieOptions(600)); // 10 min
  return res;
}
