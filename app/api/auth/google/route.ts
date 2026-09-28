import { NextRequest, NextResponse } from "next/server";
import { buildAuthUrl, callbackUrl, resolveBaseUrl } from "@/lib/auth/google";
import { sessionCookieOptions } from "@/lib/auth/session";

const STATE_COOKIE = "oauth_state";

// Every response here is per-request: the CSRF state cookie is minted fresh on
// each call, so a shared cache replaying either redirect would hand a stale
// state to the browser and the callback would reject the login.
const noStore = { "Cache-Control": "no-store" };

// Start the Google login flow: stash a CSRF state value, then redirect to Google.
export async function GET(request: NextRequest) {
  const base = resolveBaseUrl(request.nextUrl.origin);
  const state = crypto.randomUUID();

  let authUrl: string;
  try {
    authUrl = buildAuthUrl(callbackUrl(base), state);
  } catch {
    // Google credentials not configured yet — fail gracefully instead of 500.
    const home = new URL("/", base);
    home.searchParams.set("auth_error", "not_configured");
    return NextResponse.redirect(home, { headers: noStore });
  }

  const res = NextResponse.redirect(authUrl, { headers: noStore });
  res.cookies.set(STATE_COOKIE, state, sessionCookieOptions(600)); // 10 min
  return res;
}
