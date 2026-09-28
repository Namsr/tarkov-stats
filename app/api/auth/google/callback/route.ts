import { after, NextRequest, NextResponse } from "next/server";
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
import { recordAuthSignIn } from "@/lib/admin/request-events";

export const runtime = "nodejs";

const STATE_COOKIE = "oauth_state";

// All four branches are per-request: the error redirects carry a one-shot
// `auth_error`, and the success branch mints the session cookie. Nothing here is
// cacheable by a shared cache standing in front of the app.
const noStore = { "Cache-Control": "no-store" };

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
    return NextResponse.redirect(home, { headers: noStore });
  }

  // CSRF protection: the returned state must match the one we set.
  if (!code || !state || !storedState || state !== storedState) {
    home.searchParams.set("auth_error", "invalid_state");
    return NextResponse.redirect(home, { headers: noStore });
  }

  try {
    const accessToken = await exchangeCode(code, callbackUrl(base));
    const user = await fetchGoogleUser(accessToken);
    const token = await encryptSession(user);
    after(() => recordAuthSignIn(user.sub));

    const res = NextResponse.redirect(home, { headers: noStore });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    res.cookies.delete(STATE_COOKIE);
    return res;
  } catch {
    home.searchParams.set("auth_error", "login_failed");
    const res = NextResponse.redirect(home, { headers: noStore });
    res.cookies.delete(STATE_COOKIE);
    return res;
  }
}
