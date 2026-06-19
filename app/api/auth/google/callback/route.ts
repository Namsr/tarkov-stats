import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCode,
  fetchGoogleUser,
  callbackUrl,
  resolveBaseUrl,
} from "@/lib/auth/google";
import {
  encryptSession,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";

const STATE_COOKIE = "oauth_state";

// Google redirects the user here with ?code & ?state after consent.
export async function GET(request: NextRequest) {
  const base = resolveBaseUrl(request.nextUrl.origin);
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get(STATE_COOKIE)?.value;
  const oauthError = searchParams.get("error");

  const home = new URL("/", base);

  // User denied consent or Google returned an error.
  if (oauthError) {
    home.searchParams.set("auth_error", oauthError);
    return NextResponse.redirect(home);
  }

  // CSRF protection: the returned state must match the one we set.
  if (!code || !state || !storedState || state !== storedState) {
    home.searchParams.set("auth_error", "invalid_state");
    return NextResponse.redirect(home);
  }

  try {
    const accessToken = await exchangeCode(code, callbackUrl(base));
    const user = await fetchGoogleUser(accessToken);
    const token = await encryptSession(user);

    const res = NextResponse.redirect(home);
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    res.cookies.delete(STATE_COOKIE);
    return res;
  } catch {
    home.searchParams.set("auth_error", "login_failed");
    const res = NextResponse.redirect(home);
    res.cookies.delete(STATE_COOKIE);
    return res;
  }
}
