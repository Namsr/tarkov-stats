/** Google OAuth 2.0 Authorization Code flow helpers (no SDK, just fetch). */

export interface GoogleUser {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

function getClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not set");
  return id;
}

function getClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return secret;
}

/** Where Google sends the user back. Derived from the request origin so the
 *  same code works on localhost and in production without extra config. */
export function callbackUrl(origin: string): string {
  return `${origin}/api/auth/google/callback`;
}

/** Build the Google consent-screen URL to redirect the user to. */
export function buildAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchange the one-time authorization code for an access token. */
export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in token response");
  return data.access_token;
}

/** Fetch the user's Google profile with the access token. */
export async function fetchGoogleUser(accessToken: string): Promise<GoogleUser> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Userinfo request failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  return {
    sub: data.sub,
    email: data.email ?? "",
    name: data.name ?? data.email ?? "Player",
    picture: data.picture ?? "",
  };
}
